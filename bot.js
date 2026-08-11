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

  // ---------- Escucha de mensajes ----------
  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;

    for (const msg of event.messages) {
      // Ignorar mensajes enviados por el propio bot o sin contenido
      if (msg.key.fromMe || !msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) continue; // Ignorar grupos

      console.log(`📩 Mensaje recibido de ${remoteJid}`);

      // Mensaje exacto de confirmación
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
        // Al incluir { quoted: msg } WhatsApp rutea correctamente el mensaje enviado a direcciones @lid
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

function getLatestQR() { return latestQR; }
function isConnected() { return isReady; }

module.exports = {
  startBot,
  getLatestQR,
  isConnected,
};

startBot();