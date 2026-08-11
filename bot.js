// Polyfill necesario para entornos de Node.js donde crypto no es global
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

// ---------- Control de cooldown por usuario ----------
const userCooldowns = new Map();
const CHAT_COOLDOWN_MS = 0; // Desactivado para pruebas

// ---------- Control de reintentos de conexión ----------
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY_MS = 30000;
const MAX_DELAY_MS = 300000;

// ---------- Enlaces y datos ----------
const LINK_RESERVAS = 'https://nomadcode02-design.github.io/amb-barber/';

function limpiarSesionViejaUnaVez() {
  const marker = path.join(__dirname, '.sesion-vieja-borrada');
  const authPath = path.join(__dirname, 'auth_info');
  if (fs.existsSync(marker)) return;
  if (fs.existsSync(authPath)) {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('🧹 Se borró una sesión vieja de WhatsApp.');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Heartbeat para evitar instancias duplicadas ----------
const LATIDO_PATH = path.join(__dirname, 'auth_info', '.instance-heartbeat');
const LATIDO_INTERVALO_MS = 10000;
const LATIDO_VENCIDO_MS = 25000;
let latidoTimer = null;

function otraInstanciaActiva() {
  try {
    const raw = fs.readFileSync(LATIDO_PATH, 'utf8');
    const ultimoLatido = parseInt(raw, 10);
    if (!ultimoLatido) return false;
    return Date.now() - ultimoLatido < LATIDO_VENCIDO_MS;
  } catch (e) {
    return false;
  }
}

function actualizarLatido() {
  try {
    fs.mkdirSync(path.dirname(LATIDO_PATH), { recursive: true });
    fs.writeFileSync(LATIDO_PATH, String(Date.now()));
  } catch (e) {
    console.error('Error actualizando el archivo de latido:', e);
  }
}

function iniciarLatido() {
  detenerLatido();
  actualizarLatido();
  latidoTimer = setInterval(actualizarLatido, LATIDO_INTERVALO_MS);
}

function detenerLatido() {
  if (latidoTimer) {
    clearInterval(latidoTimer);
    latidoTimer = null;
  }
}

async function startBot() {
  limpiarSesionViejaUnaVez();

  if (otraInstanciaActiva()) {
    console.log('⚠️ Se detectó otra instancia del bot activa. Esperando 20s...');
    await sleep(20000);
    if (otraInstanciaActiva()) {
      console.log('❌ La otra instancia sigue activa. Reintentando en 30s...');
      setTimeout(startBot, 30000);
      return;
    }
  }

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
      console.log('\n=== Nuevo QR disponible ===\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      isReady = false;
      detenerLatido();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.restartRequired) {
        setTimeout(startBot, 500);
        return;
      }

      const esConflicto = /conflict/i.test(lastDisconnect?.error?.message || '');
      if (esConflicto) {
        setTimeout(startBot, 15000);
        return;
      }

      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) return;
        const delay = Math.min(BASE_DELAY_MS * 2 ** (reconnectAttempts - 1), MAX_DELAY_MS);
        setTimeout(startBot, delay);
      } else {
        const authPath = path.join(__dirname, 'auth_info');
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {}
      }
    } else if (connection === 'open') {
      isReady = true;
      latestQR = null;
      reconnectAttempts = 0;
      iniciarLatido();
      console.log('✅ Bot de WhatsApp conectado y listo.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ---------- Escucha de mensajes entrantes ----------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) continue;
      if (!msg.message) continue;

      let targetJid = remoteJid;

      // Si viene por LID, intentar extraer el participante real
      if (targetJid.endsWith('@lid')) {
        const participant = msg.key.participant || msg.participant;
        if (participant) {
          targetJid = participant;
        }
      }

      // Extraer el texto del mensaje
      const textoRecibido = (
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text || 
        ''
      ).toLowerCase().trim();

      console.log(`📩 Mensaje recibido de ${targetJid}: "${textoRecibido}"`);

      // Cooldown por usuario
      const now = Date.now();
      const lastSentTime = userCooldowns.get(targetJid) || 0;

      if (CHAT_COOLDOWN_MS > 0 && (now - lastSentTime < CHAT_COOLDOWN_MS)) {
        continue;
      }

      // Armar la respuesta inteligente según lo que mandó el cliente
      let textoRespuesta = '';

      if (textoRecibido.includes('acabo de sacar un turno') || textoRecibido.includes('reserva') || textoRecibido.includes('turno')) {
        textoRespuesta = 
          `¡Hola! 🙌 Recibimos tu confirmación de turno desde la web.\n\n` +
          `Tu reserva quedó registrada correctamente en AMB BARBERS. ¡Te esperamos! ✂️💈`;
      } else {
        textoRespuesta = 
          `¡Hola! 👋 Gracias por escribir a AMB BARBERS.\n\n` +
          `En este momento estamos ocupados o fuera de horario, pero te responderemos a la brevedad.\n\n` +
          `Si querés reservar un turno ahora mismo de forma rápida, podés hacerlo desde acá:\n` +
          `${LINK_RESERVAS}\n\n` +
          `¡Nos vemos!`;
      }

      try {
        await sock.sendMessage(targetJid, { text: textoRespuesta });
        userCooldowns.set(targetJid, Date.now());
        console.log(`✅ Respuesta enviada a ${targetJid}`);
      } catch (e) {
        console.error(`❌ Error enviando mensaje a ${targetJid}:`, e);
      }
    }
  });

  return sock;
}

// Normaliza un número a formato de WhatsApp
function toWhatsAppId(numero) {
  let n = numero.replace(/[^\d]/g, '');
  if (!n.startsWith('54')) n = '54' + n;
  if (!n.startsWith('549')) n = '549' + n.slice(2);
  return `${n}@s.whatsapp.net`;
}

// ---------- Cola de envíos manuales ----------
const messageQueue = [];
let isProcessingQueue = false;

const MIN_DELAY_MS = 2500;
const MAX_DELAY_MS_SEND = 6000;
const RATE_LIMIT_MAX_PER_MINUTE = 15;
const RATE_LIMIT_WINDOW_MS = 60000;
let sentTimestamps = [];

function randomDelay() {
  return Math.floor(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS_SEND - MIN_DELAY_MS));
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const now = Date.now();
    sentTimestamps = sentTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (sentTimestamps.length >= RATE_LIMIT_MAX_PER_MINUTE) {
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - sentTimestamps[0]) + 500;
      await sleep(waitMs);
      continue;
    }

    const job = messageQueue.shift();

    try {
      if (!sock || !isReady) throw new Error('El bot no está conectado.');
      
      const jid = job.numero.endsWith('@s.whatsapp.net') || job.numero.endsWith('@lid') ? job.numero : toWhatsAppId(job.numero);

      const SEND_TIMEOUT_MS = 20000;
      const result = await Promise.race([
        sock.sendMessage(jid, { text: job.texto }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout de envío')), SEND_TIMEOUT_MS)),
      ]);

      sentTimestamps.push(Date.now());
      job.resolve(result);
    } catch (e) {
      job.reject(e);
    }

    if (messageQueue.length > 0) {
      await sleep(randomDelay());
    }
  }

  isProcessingQueue = false;
}

function sendMessage(numero, texto) {
  return new Promise((resolve, reject) => {
    messageQueue.push({ numero, texto, resolve, reject });
    processQueue();
  });
}

function getLatestQR() { return latestQR; }
function isConnected() { return isReady; }

module.exports = {
  startBot,
  sendMessage,
  toWhatsAppId,
  getLatestQR,
  isConnected,
};