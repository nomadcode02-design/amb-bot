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

// Formatea el número a formato de WhatsApp
function toWhatsAppId(numero) {
  let n = String(numero).replace(/[^\d]/g, '');
  if (!n.startsWith('54')) n = '54' + n;
  if (!n.startsWith('549')) n = '549' + n.slice(2);
  return `${n}@s.whatsapp.net`;
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

  // ---------- Escucha de mensajes entrantes ----------
  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;

    for (const msg of event.messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) continue;

      console.log(`📩 Mensaje recibido de ${remoteJid}`);

      const textoConfirmacion = 
`✅ Turno confirmado - AMB BARBERS

Hola tiziano lobos! Tu turno quedó agendado:

💈 Barbero: Sebastian
✂️ Servicio: Corte moderno (incluye lavado)
📅 Día: 11/08/2026
🕐 Hora: 17:00 hs
💰 Precio: $12.000

📍 Calle 9 de Julio, entre Mitre y Av. Ramón Barrera, Santa Rosa - 25 de Mayo, San Juan.

Te esperamos. Si necesitás cambiar el turno, respondé este mensaje.`;

      try {
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

// Función requerida por server.js para enviar reservas y recordatorios
async function sendMessage(numero, texto) {
  if (!sock || !isReady) {
    throw new Error('El bot de WhatsApp aún no está conectado.');
  }

  const jid = (typeof numero === 'string' && (numero.endsWith('@s.whatsapp.net') || numero.endsWith('@lid')))
    ? numero
    : toWhatsAppId(numero);

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