// Polyfill para Node.js
const nodeCrypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = nodeCrypto.webcrypto;
}
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

let sock = null;
let isReady = false;
let latestQR = null;
let onMensajeEntrante = null; // callback que registra server.js

// Carpeta de datos persistentes. En Railway, montá un Volume en /data
// y seteá la variable de entorno DATA_DIR=/data — así auth_info y los
// JSON sobreviven a reinicios y redeploys. Si no hay volumen (ej. en tu
// máquina local), usa la carpeta del proyecto como antes.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Reseteo de sesión: si RESET_SESSION=true está seteada como variable de
// entorno, borra la carpeta auth_info (sesión de cifrado corrupta, error
// "Bad MAC") antes de arrancar, forzando un reemparejamiento limpio por QR.
// IMPORTANTE: sacar esta variable después de usarla una vez, o borrará la
// sesión en cada reinicio.
const AUTH_DIR = path.join(DATA_DIR, 'auth_info');
if (process.env.RESET_SESSION === 'true' && fs.existsSync(AUTH_DIR)) {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  console.log('🗑️ auth_info borrado por RESET_SESSION=true. Va a pedir escanear QR de nuevo.');
}

// ---------- Ventana de conversación (24hs) ----------
// Guardamos cuándo fue el último mensaje QUE NOS ESCRIBIÓ cada contacto.
// Solo mandamos mensajes proactivos (confirmaciones, recordatorios) si
// el contacto nos escribió dentro de las últimas 24hs. Así imitamos la
// regla real de WhatsApp Business y evitamos mandar a quien nunca inició
// conversación con el bot.
const CONTACTOS_FILE = path.join(DATA_DIR, 'contactos.json');
if (!fs.existsSync(CONTACTOS_FILE)) fs.writeFileSync(CONTACTOS_FILE, '{}');

function leerContactos() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTOS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function registrarContacto(jid, jidAlt) {
  const contactos = leerContactos();
  const ahora = new Date().toISOString();
  // Guardamos bajo las dos formas del JID (@lid y @s.whatsapp.net) para que
  // no importe cuál de las dos se use después al consultar la ventana:
  // Baileys puede identificar al mismo contacto de cualquiera de las dos
  // formas según el contexto, y si solo guardamos una, la otra siempre da
  // "false" aunque el contacto sí haya escrito.
  contactos[jid] = ahora;
  if (jidAlt) contactos[jidAlt] = ahora;
  fs.writeFileSync(CONTACTOS_FILE, JSON.stringify(contactos, null, 2));
}

function ventanaAbierta(jid) {
  const contactos = leerContactos();
  const ultimo = contactos[jid];
  if (!ultimo) return false;
  const horas = (Date.now() - new Date(ultimo).getTime()) / 3600000;
  return horas <= 24;
}

// Limpia el número para consultarlo con onWhatsApp
function limpiarNumero(numero) {
  let n = String(numero).replace(/[^\d]/g, '');
  if (!n) return '';
  if (n.startsWith('0')) n = n.slice(1);
  if (n.startsWith('549')) return n;
  if (n.startsWith('54')) return `549${n.slice(2)}`;
  return `549${n}`;
}

// Delay aleatorio para simular tiempo de respuesta humano (2-6 segundos)
function delayAleatorio() {
  const ms = 2000 + Math.random() * 4000;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- Cooldown de envíos (para no "volver loco" a WhatsApp) ----------
// 1) Cola global: TODOS los envíos (confirmaciones, recordatorios, avisos al
//    dueño, respuestas de ausencia) pasan por acá y se mandan de a uno, nunca
//    en paralelo, con un espacio mínimo entre cualquier par de mensajes.
// 2) Cooldown por contacto: además, a un mismo número no se le manda más de
//    un mensaje dentro de esa misma ventana corta, por si algo dispara un
//    envío duplicado por error.
const COOLDOWN_GLOBAL_MS = 12000; // mínimo entre dos envíos, sean a quien sean
const COOLDOWN_CONTACTO_MS = 45000; // mínimo entre dos mensajes al MISMO número

let colaEnvios = Promise.resolve();
let ultimoEnvioGlobal = 0;
const ultimoEnvioPorJid = {};

function encolarEnvio(jid, fn) {
  colaEnvios = colaEnvios.then(async () => {
    const ahora = () => Date.now();

    // Esperar el cooldown global (desde el último envío, sea a quien sea)
    let espera = COOLDOWN_GLOBAL_MS - (ahora() - ultimoEnvioGlobal);
    if (espera > 0) await new Promise(r => setTimeout(r, espera));

    // Esperar el cooldown por contacto, si a ESE jid ya se le mandó algo hace poco
    const ultimoAEsteJid = ultimoEnvioPorJid[jid] || 0;
    espera = COOLDOWN_CONTACTO_MS - (ahora() - ultimoAEsteJid);
    if (espera > 0) {
      console.log(`⏳ Cooldown: esperando ${Math.ceil(espera / 1000)}s antes de volver a escribirle a ${jid}`);
      await new Promise(r => setTimeout(r, espera));
    }

    ultimoEnvioGlobal = Date.now();
    ultimoEnvioPorJid[jid] = Date.now();
    return fn();
  });
  return colaEnvios;
}

// Reintenta el envío si falla. Sirve para el caso en que Baileys está
// renegociando la sesión de cifrado con el contacto (log "Closing session")
// justo cuando se intenta mandar: el primer intento puede perderse, pero
// una vez renegociada la sesión el reintento sí llega.
async function enviarConReintento(jid, texto, intentos = 3) {
  return encolarEnvio(jid, () => enviarConReintentoInterno(jid, texto, intentos));
}

async function enviarConReintentoInterno(jid, texto, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    try {
      await sock.sendMessage(jid, { text: texto });
      console.log(`✅ Respuesta entregada con éxito a ${jid} (intento ${i})`);
      return;
    } catch (err) {
      console.error(`⚠️ Falló intento ${i}/${intentos} enviando a ${jid}:`, err.message || err);
      if (i < intentos) {
        await new Promise(resolve => setTimeout(resolve, 2000 * i));
      } else {
        throw err;
      }
    }
  }
}

// Arma el link de WhatsApp para que el CLIENTE inicie la conversación
function armarLinkWhatsApp(numero, textoPredefinido) {
  const limpio = limpiarNumero(numero);
  return `https://wa.me/${limpio}?text=${encodeURIComponent(textoPredefinido)}`;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      console.log('\n=== NUEVO QR DISPONIBLE ===\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('❌ Conexión cerrada. Código:', statusCode);
      setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      isReady = true;
      latestQR = null;
      console.log('✅ BOT CONECTADO EXITOSAMENTE Y LISTO');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ---------- Escucha de mensajes de WhatsApp ----------
  // Acá el CLIENTE siempre escribe primero, así que responder es seguro.
  // La decisión de QUÉ contestar la toma server.js (que tiene los turnos),
  // vía el callback registrado con setOnMensaje().
  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;

    for (const msg of event.messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) continue;
      const remoteJidAlt = msg.key.remoteJidAlt || null;

      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      console.log(`📩 Mensaje recibido de: ${remoteJid} — "${texto}"`);
      console.log('🔎 msg.key completo:', JSON.stringify(msg.key));

      // Registramos el contacto (bajo las dos formas de JID): esto abre
      // la ventana de 24hs para poder mandarle confirmaciones/recordatorios
      // de forma proactiva.
      registrarContacto(remoteJid, remoteJidAlt);

      if (!onMensajeEntrante) continue;

      // Algunas cuentas @lid tienen un JID "alternativo" (el número real,
      // @s.whatsapp.net) que Baileys expone en remoteJidAlt cuando lo conoce.
      // Mandar ahí en vez de al @lid suele solucionar el problema de que
      // el mensaje se "entrega" según el log pero nunca llega al teléfono.
      const jidDestino = remoteJidAlt || remoteJid;

      try {
        const respuesta = await onMensajeEntrante(remoteJid, texto, remoteJidAlt);
        if (!respuesta) continue; // server.js decidió no responder nada

        await delayAleatorio();
        // Sin "quoted": citar mensajes @lid es una causa conocida de que
        // Baileys reporte éxito pero WhatsApp no entregue nada.
        await enviarConReintento(jidDestino, respuesta);
      } catch (err) {
        console.error(`❌ Error procesando/entregando mensaje a ${jidDestino}:`, err);
      }
    }
  });

  return sock;
}

// Resuelve el JID real de un número (puede ser @s.whatsapp.net o @lid)
async function resolverJid(numero) {
  const numeroLimpio = limpiarNumero(numero);
  const resultados = await sock.onWhatsApp(numeroLimpio);
  const resultado = resultados && resultados[0];
  if (!resultado?.exists) return null;
  return resultado.jid;
}

// Envío proactivo (confirmaciones web, recordatorios, avisos al dueño).
// Devuelve { enviado: true } si se mandó, o { enviado: false, jid, whatsappLink }
// si no se pudo mandar porque el contacto no está dentro de la ventana de 24hs.
async function sendMessage(numero, texto, { forzar = false } = {}) {
  if (!sock || !isReady) {
    throw new Error('El bot de WhatsApp aún no está conectado.');
  }

  let jid = numero;
  if (typeof numero === 'string' && !numero.endsWith('@s.whatsapp.net') && !numero.endsWith('@lid')) {
    jid = await resolverJid(numero);
    if (!jid) {
      throw new Error(`El número ${numero} no tiene WhatsApp o no se pudo verificar.`);
    }
  }

  if (!forzar && !ventanaAbierta(jid)) {
    console.log(`⏸️ No se manda a ${jid}: el contacto no escribió en las últimas 24hs.`);
    return {
      enviado: false,
      jid,
      whatsappLink: armarLinkWhatsApp(numero, 'Hola! Quiero confirmar mi turno en AMB Barbers 💈'),
    };
  }

  console.log(`📤 Enviando mensaje a: ${jid}`);
  await encolarEnvio(jid, async () => {
    await delayAleatorio();
    await sock.sendMessage(jid, { text: texto });
  });
  return { enviado: true, jid };
}

function getLatestQR() { return latestQR; }
function isConnected() { return isReady; }

// server.js llama a esto una vez, pasándole una función que recibe
// (remoteJid, textoRecibido) y devuelve el texto a responder (o null/undefined
// para no responder nada).
function setOnMensaje(callback) {
  onMensajeEntrante = callback;
}

module.exports = {
  startBot,
  sendMessage,
  armarLinkWhatsApp,
  resolverJid,
  setOnMensaje,
  getLatestQR,
  isConnected,
};
