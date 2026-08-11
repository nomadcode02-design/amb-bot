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

function registrarContacto(jid) {
  const contactos = leerContactos();
  contactos[jid] = new Date().toISOString();
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

// Arma el link de WhatsApp para que el CLIENTE inicie la conversación
function armarLinkWhatsApp(numero, textoPredefinido) {
  const limpio = limpiarNumero(numero);
  return `https://wa.me/${limpio}?text=${encodeURIComponent(textoPredefinido)}`;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(DATA_DIR, 'auth_info')
  );
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

      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      console.log(`📩 Mensaje recibido de: ${remoteJid} — "${texto}"`);

      // Registramos el contacto: esto abre la ventana de 24hs para
      // poder mandarle confirmaciones/recordatorios de forma proactiva.
      registrarContacto(remoteJid);

      if (!onMensajeEntrante) continue;

      try {
        const respuesta = await onMensajeEntrante(remoteJid, texto);
        if (!respuesta) continue; // server.js decidió no responder nada

        await delayAleatorio();
        await sock.sendMessage(remoteJid, { text: respuesta }, { quoted: msg });
        console.log(`✅ Respuesta entregada con éxito a ${remoteJid}`);
      } catch (err) {
        console.error(`❌ Error procesando/entregando mensaje a ${remoteJid}:`, err);
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

  await delayAleatorio();
  console.log(`📤 Enviando mensaje a: ${jid}`);
  await sock.sendMessage(jid, { text: texto });
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
