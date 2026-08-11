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

// ---------- Control de cooldown por usuario ----------
const userCooldowns = new Map();
const CHAT_COOLDOWN_MS = 0; // Desactivado para pruebas

// ---------- Control de reintentos de conexión ----------
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY_MS = 30000;
const MAX_DELAY_MS = 300000;

// ---------- Horario de atención ----------
const HORA_APERTURA = 9;
const HORA_CIERRE = 21;
const LINK_RESERVAS = 'https://nomadcode02-design.github.io/amb-barber/';

function estaDentroDeHorario(fecha = new Date()) {
  const hora = fecha.getHours();
  return hora >= HORA_APERTURA && hora < HORA_CIERRE;
}

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

// ---------- Detección de instancias duplicadas (heartbeat) ----------
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
    console.log('⚠️ Se detectó otra instancia del bot activa hace muy poco. Esperando 20s...');
    await sleep(20000);
    if (otraInstanciaActiva()) {
      console.log('❌ La otra instancia sigue activa. Reintentando en 30s más...');
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
      console.log('\n=== Nuevo QR disponible. Entrá a /qr en tu navegador para verlo ===\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      isReady = false;
      detenerLatido();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Código:', statusCode, '| Motivo:', lastDisconnect?.error?.message);

      if (statusCode === DisconnectReason.restartRequired) {
        console.log('Reinicio requerido. Reconectando ya...');
        setTimeout(startBot, 500);
        return;
      }

      const esConflicto = /conflict/i.test(lastDisconnect?.error?.message || '');
      if (esConflicto) {
        console.log('⚠️ Conflicto de conexión detectado. Reintentando en 15 segundos...');
        setTimeout(startBot, 15000);
        return;
      }

      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          console.log(`❌ Se alcanzaron los ${MAX_RECONNECT_ATTEMPTS} reintentos máximos.`);
          return;
        }
        const delay = Math.min(BASE_DELAY_MS * 2 ** (reconnectAttempts - 1), MAX_DELAY_MS);
        console.log(`Reintentando en ${delay / 1000} segundos...`);
        setTimeout(startBot, delay);
      } else {
        console.log('Sesión cerrada (logout). Borrando credenciales viejas...');
        const authPath = path.join(__dirname, 'auth_info');
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {
          console.error('Error borrando credenciales viejas:', e);
        }
      }
    } else if (connection === 'open') {
      isReady = true;
      latestQR = null;
      reconnectAttempts = 0;
      iniciarLatido();
      console.log('✅ Bot de WhatsApp conectado y listo para recibir mensajes.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ---------- Escucha de mensajes entrantes ----------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignorar si el mensaje fue enviado por el propio bot
      if (msg.key.fromMe) continue;
      
      // Ignorar grupos
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) continue;
      if (!msg.message) continue;

      // Determinación robusta del destinatario para responder directamente al canal de entrada
      let targetJid = remoteJid;

      // Si viene por LID, tratar de usar el participante o mantener el chat de origen
      if (targetJid.endsWith('@lid')) {
        const participant = msg.key.participant || msg.participant;
        if (participant) {
          targetJid = participant;
        }
      }

      console.log(`📩 Mensaje entrante detectado desde: ${targetJid}`);

      // Cooldown por usuario
      const now = Date.now();
      const lastSentTime = userCooldowns.get(targetJid) || 0;

      if (CHAT_COOLDOWN_MS > 0 && (now - lastSentTime < CHAT_COOLDOWN_MS)) {
        console.log(`⏳ Ignorando mensaje de ${targetJid} por cooldown.`);
        continue;
      }

      try {
        const textoRespuesta = 
          `¡Hola! 👋 Gracias por comunicarte con AMB BARBERS.\n` +
          `En este momento no estamos respondiendo. Lo haremos lo antes posible!\n\n` +
          `Podés reservar tu turno igual desde nuestra página y te confirmamos el lugar 😉\n\n` +
          `Link: ${LINK_RESERVAS}\n\n` +
          `Nos vemos!`;

        // Responder directamente al socket para evitar bloqueos en la cola durante la prueba
        await sock.sendMessage(targetJid, { text: textoRespuesta });

        userCooldowns.set(targetJid, Date.now());
        console.log(`✅ Respuesta automática enviada instantáneamente a ${targetJid}`);
      } catch (e) {
        console.error(`❌ Error enviando respuesta automática a ${targetJid}:`, e);
      }
    }
  });

  return sock;
}

// Normaliza un número argentino a formato E.164 para WhatsApp
function toWhatsAppId(numero) {
  let n = numero.replace(/[^\d]/g, '');
  if (!n.startsWith('54')) n = '54' + n;
  if (!n.startsWith('549')) n = '549' + n.slice(2);
  return `${n}@s.whatsapp.net`;
}

// ---------- Cola de mensajes manuales ----------
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
      console.log(`⏳ Límite de ${RATE_LIMIT_MAX_PER_MINUTE} msgs/min alcanzado. Esperando ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }

    const job = messageQueue.shift();

    try {
      if (!sock || !isReady) {
        throw new Error('El bot todavía no está conectado a WhatsApp.');
      }
      
      const jid = job.numero.endsWith('@s.whatsapp.net') || job.numero.endsWith('@lid') ? job.numero : toWhatsAppId(job.numero);
      console.log(`📤 Mandando mensaje programado a ${jid}...`);

      const SEND_TIMEOUT_MS = 20000;
      const result = await Promise.race([
        sock.sendMessage(jid, { text: job.texto }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`Timeout al enviar a ${jid}`)), SEND_TIMEOUT_MS)
        ),
      ]);

      sentTimestamps.push(Date.now());
      console.log(`✅ Mensaje en cola enviado a ${jid}. ID: ${result?.key?.id || 'desconocido'}`);
      job.resolve(result);
    } catch (e) {
      console.error(`❌ Error mandando mensaje a ${job.numero}:`, e.message);
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