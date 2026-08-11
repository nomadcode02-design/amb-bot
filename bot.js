// Polyfill necesario: Baileys usa el objeto global "crypto", que en algunas
// versiones/entornos de Node.js no está disponible como global por defecto.
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

// ---------- Control de reintentos de conexión (cooldown) ----------
// Evita el loop infinito de reconexión que puede hacer que WhatsApp
// suspenda el número por comportamiento sospechoso (muchos intentos seguidos).
// Arranca esperando 30 segundos entre intentos (no 5, para ser menos agresivo)
// y va duplicando el tiempo de espera hasta un tope de 5 minutos.
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY_MS = 30000; // 30 segundos
const MAX_DELAY_MS = 300000; // tope de 5 minutos entre intentos

// ---------- Horario de atención (se muestra en textos, pero el aviso ahora es 24hs) ----------
const HORA_APERTURA = 9;  // 9 am
const HORA_CIERRE = 21;   // 9 pm
// Ajustá este link al real de tu página de reservas
const LINK_RESERVAS = 'https://nomadcode02-design.github.io/amb-barber/';

function estaDentroDeHorario(fecha = new Date()) {
  const hora = fecha.getHours();
  return hora >= HORA_APERTURA && hora < HORA_CIERRE;
}

// ---------- Limpieza ÚNICA de una sesión vieja que haya quedado pegada ----------
// Esto corre UNA sola vez (se marca con un archivo aparte) para borrar la
// carpeta auth_info con la sesión de prueba. Después de que esto se ejecute
// una vez y confirmes que anda bien, se puede sacar este bloque del código.
function limpiarSesionViejaUnaVez() {
  const marker = path.join(__dirname, '.sesion-vieja-borrada');
  const authPath = path.join(__dirname, 'auth_info');
  if (fs.existsSync(marker)) return; // ya se hizo, no repetir
  if (fs.existsSync(authPath)) {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('🧹 Se borró una sesión vieja de WhatsApp que había quedado guardada.');
    } catch (e) {
      console.error('Error borrando la sesión vieja:', e);
    }
  }
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) {
    console.error('Error guardando la marca de limpieza:', e);
  }
}

async function startBot() {
  limpiarSesionViejaUnaVez();
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, 'auth_info')
  );
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      console.log('\n=== Nuevo QR disponible. Entrá a /qr en tu navegador para verlo ===\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Código:', statusCode, '| Motivo:', lastDisconnect?.error?.message);

      // El código 515 (restart required) es un paso NORMAL justo después de
      // vincular un dispositivo por primera vez — no es un error real ni
      // indica que WhatsApp esté bloqueando nada. Reconectar casi al
      // instante, sin el cooldown lento pensado para errores de verdad.
      if (statusCode === DisconnectReason.restartRequired) {
        console.log('Reinicio requerido (normal después de vincular). Reconectando ya...');
        setTimeout(startBot, 500);
        return;
      }

      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          console.log(
            `❌ Se alcanzaron los ${MAX_RECONNECT_ATTEMPTS} reintentos máximos. ` +
            `El bot dejó de intentar conectar para no arriesgar el número. ` +
            `Reiniciá el servicio manualmente (redeploy en Railway) cuando quieras retomar.`
          );
          return; // corta el loop, NO vuelve a llamar a startBot
        }
        // Backoff exponencial: 30s, 60s, 120s, 240s, 300s (tope)
        const delay = Math.min(BASE_DELAY_MS * 2 ** (reconnectAttempts - 1), MAX_DELAY_MS);
        console.log(
          `Reintentando en ${delay / 1000} segundos... (intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
        );
        setTimeout(startBot, delay);
      } else {
        console.log('Sesión cerrada (logout). Borrando credenciales viejas...');
        const authPath = path.join(__dirname, 'auth_info');
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {
          console.error('Error borrando credenciales viejas:', e);
        }
        console.log(
          '⚠️ No se genera un QR nuevo automáticamente. ' +
          'Reiniciá el servicio manualmente (redeploy en Railway) cuando quieras escanear uno nuevo.'
        );
        // Importante: ya NO se llama a startBot acá automáticamente.
        // Esto evita el loop de "logout -> borra creds -> genera QR -> falla -> logout -> ..."
      }
    } else if (connection === 'open') {
      isReady = true;
      latestQR = null;
      reconnectAttempts = 0; // resetea el contador apenas conecta bien
      console.log('✅ Bot de WhatsApp conectado y listo para confirmar turnos.');
    }
  });
  sock.ev.on('creds.update', saveCreds);

  // ---------- Escucha de mensajes entrantes ----------
  // Este mensaje se manda siempre (24/7), esté dentro o fuera del horario de atención.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignorar mensajes propios y de grupos
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (!msg.message) continue;

      console.log(`📩 Mensaje entrante de ${msg.key.remoteJid}, respondiendo...`);

      try {
        await sendMessage(
          msg.key.remoteJid,
          `¡Hola! 👋 Gracias por comunicarte con AMB BARBERS.\n` +
            `En este momento no estamos respondiendo. Lo haremos lo antes posible!\n\n` +
            `Podés reservar tu turno igual desde nuestra página y te confirmamos el lugar 😉\n\n` +
            `Link: ${LINK_RESERVAS}\n\n` +
            `Nos vemos!`
        );
        console.log(`✅ Respuesta automática enviada a ${msg.key.remoteJid}`);
      } catch (e) {
        console.error('Error respondiendo al mensaje entrante:', e);
      }
    }
  });

  return sock;
}

// Normaliza un número argentino a formato E.164 para WhatsApp (whatsappId)
function toWhatsAppId(numero) {
  let n = numero.replace(/[^\d]/g, '');
  if (!n.startsWith('54')) n = '54' + n;
  // Baileys/WhatsApp requiere el 9 luego del 54 para celulares argentinos
  if (!n.startsWith('549')) n = '549' + n.slice(2);
  return `${n}@s.whatsapp.net`;
}

// ---------- Cola de mensajes con cooldown ----------
// En vez de mandar cada mensaje apenas se pide, los encolamos y los vamos
// disparando de a uno, con una pausa random entre cada uno. Esto evita el
// patrón de "ráfaga de mensajes" que WhatsApp puede interpretar como spam
// y que termina cerrando la sesión con un error 401.
const messageQueue = [];
let isProcessingQueue = false;

const MIN_DELAY_MS = 2500;   // pausa mínima entre mensajes
const MAX_DELAY_MS_SEND = 6000; // pausa máxima entre mensajes

// Colchón extra: nunca mandar más de N mensajes por minuto, pase lo que pase.
const RATE_LIMIT_MAX_PER_MINUTE = 15;
const RATE_LIMIT_WINDOW_MS = 60000;
let sentTimestamps = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return Math.floor(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS_SEND - MIN_DELAY_MS));
}

async function processQueue() {
  if (isProcessingQueue) return; // ya hay un worker corriendo
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    // Chequeo de rate limit por minuto
    const now = Date.now();
    sentTimestamps = sentTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (sentTimestamps.length >= RATE_LIMIT_MAX_PER_MINUTE) {
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - sentTimestamps[0]) + 500;
      console.log(`⏳ Límite de ${RATE_LIMIT_MAX_PER_MINUTE} mensajes/min alcanzado. Esperando ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }

    const job = messageQueue.shift();

    try {
      if (!sock || !isReady) {
        throw new Error('El bot todavía no está conectado a WhatsApp.');
      }
      const jid = toWhatsAppId(job.numero);
      console.log(`📤 Intentando mandar mensaje a ${jid}...`);
      const result = await sock.sendMessage(jid, { text: job.texto });
      sentTimestamps.push(Date.now());
      console.log(`✅ sock.sendMessage() terminó sin errores para ${jid}. ID del mensaje: ${result?.key?.id || 'desconocido'}`);
      job.resolve(result);
    } catch (e) {
      job.reject(e);
    }

    // Pausa random antes del próximo mensaje de la cola (si queda alguno)
    if (messageQueue.length > 0) {
      const delay = randomDelay();
      await sleep(delay);
    }
  }

  isProcessingQueue = false;
}

// Encola el mensaje y devuelve una Promise que se resuelve/rechaza cuando
// efectivamente se envía. La firma es la misma que antes, así que no hace
// falta tocar el resto del código que llama a sendMessage.
function sendMessage(numero, texto) {
  return new Promise((resolve, reject) => {
    messageQueue.push({ numero, texto, resolve, reject });
    processQueue();
  });
}

function getLatestQR() {
  return latestQR;
}
function isConnected() {
  return isReady;
}

module.exports = {
  startBot,
  sendMessage,
  toWhatsAppId,
  getLatestQR,
  isConnected,
  estaDentroDeHorario,
};
