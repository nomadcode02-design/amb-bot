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
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=== Escaneá este QR con el WhatsApp de la barbería ===\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isReady = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada.', shouldReconnect ? 'Reconectando...' : 'Sesión cerrada, hay que volver a escanear el QR.');
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isReady = true;
      console.log('✅ Bot de WhatsApp conectado y listo para confirmar turnos.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

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

async function sendMessage(numero, texto) {
  if (!sock || !isReady) {
    throw new Error('El bot todavía no está conectado a WhatsApp.');
  }
  const jid = toWhatsAppId(numero);
  await sock.sendMessage(jid, { text: texto });
}

module.exports = { startBot, sendMessage, toWhatsAppId };
