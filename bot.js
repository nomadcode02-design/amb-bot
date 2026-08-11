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

// Formatea un número argentino a JID real (@s.whatsapp.net)
function toWhatsAppId(numero) {
  let n = String(numero).replace(/[^\d]/g, '');
  if (n.length === 0) return '';
  
  // Si empieza con 0, se lo saca
  if (n.startsWith('0')) n = n.slice(1);
  // Si no tiene prefijo de Argentina
  if (!n.startsWith('54')) n = '54' + n;
  // Si no tiene el 9 de celular
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

      let remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) continue;

      // Extraer el número real si el evento viene etiquetado como LID
      let numeroReal = remoteJid;
      if (remoteJid.endsWith('@lid')) {
        const participant = msg.key.participant || msg.participant;
        if (participant && participant.endsWith('@s.whatsapp.net')) {
          numeroReal = participant;
        }
      }

      console.log(`📩 Mensaje recibido de ID: ${remoteJid} | Número real detectado: ${numeroReal}`);

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
        // Enviar respuesta citando el mensaje original para asegurar la entrega
        await sock.sendMessage(
          numeroReal, 
          { text: textoConfirmacion }, 
          { quoted: msg }
        );

        console.log(`✅ Respuesta entregada con éxito a ${numeroReal}`);
      } catch (err) {
        console.error(`❌ Error entregando mensaje a ${numeroReal}:`, err);
      }
    }
  });

  return sock;
}

// Función que consume server.js para enviar reservas web y recordatorios
async function sendMessage(numero, texto) {
  if (!sock || !isReady) {
    throw new Error('El bot de WhatsApp aún no está conectado.');
  }

  // Convertir cualquier formato de número a JID válido
  let jid = numero;
  if (typeof numero === 'string' && !numero.endsWith('@s.whatsapp.net') && !numero.endsWith('@lid')) {
    jid = toWhatsAppId(numero);
  }

  console.log(`📤 Enviando mensaje saliente a JID: ${jid}`);
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