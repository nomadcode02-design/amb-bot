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

let sock = null;
let isReady = false;
let latestQR = null;

// Formatea correctamente cualquier número de Argentina a WhatsApp E.164
function toWhatsAppId(numero) {
  let n = String(numero).replace(/[^\d]/g, '');
  if (!n) return '';

  // Quitar '0' inicial si lo pusieron (ej: 0264 -> 264)
  if (n.startsWith('0')) n = n.slice(1);

  // Si ya tiene el formato completo 549...
  if (n.startsWith('549')) return `${n}@s.whatsapp.net`;

  // Si tiene 54 pero le falta el 9 de celular (ej: 54264... -> 549264...)
  if (n.startsWith('54')) return `549${n.slice(2)}@s.whatsapp.net`;

  // Si es un número local directo (ej: 264XXXXXXX)
  return `549${n}@s.whatsapp.net`;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, 'auth_info')
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
  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;

    for (const msg of event.messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) continue;

      console.log(`📩 Mensaje recibido de: ${remoteJid}`);

      const textoConfirmacion = 
`✅ Turno confirmado - AMB BARBERS

Hola! Tu turno quedó agendado.

📍 Calle 9 de Julio, entre Mitre y Av. Ramón Barrera, Santa Rosa - 25 de Mayo, San Juan.

Te esperamos. Si necesitás cambiar el turno, respondé este mensaje.`;

      try {
        // { quoted: msg } es OBLIGATORIO para que WhatsApp entregue mensajes dirigidos a IDs @lid
        await sock.sendMessage(
          remoteJid, 
          { text: textoConfirmacion }, 
          { quoted: msg }
        );

        console.log(`✅ Respuesta entregada con éxito a ${remoteJid}`);
      } catch (err) {
        console.error(`❌ Error entregando mensaje a ${remoteJid}:`, err);
      }
    }
  });

  return sock;
}

// Función que consume server.js para envíos de reservas web y recordatorios
async function sendMessage(numero, texto) {
  if (!sock || !isReady) {
    throw new Error('El bot de WhatsApp aún no está conectado.');
  }

  let jid = numero;
  // Si no viene como JID de WhatsApp (@s.whatsapp.net o @lid), formatearlo
  if (typeof numero === 'string' && !numero.endsWith('@s.whatsapp.net') && !numero.endsWith('@lid')) {
    jid = toWhatsAppId(numero);
  }

  console.log(`📤 Enviando mensaje a: ${jid}`);
  return await sock.sendMessage(jid, { text: texto });
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