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

let sock = null;
let isReady = false;
let latestQR = null;

// ---------- Horario de atención ----------
const HORA_APERTURA = 9;  // 9 am
const HORA_CIERRE = 21;   // 9 pm
// Ajustá este link al real de tu página de reservas
const LINK_RESERVAS = 'https://amb-barbers.github.io/AMB-BARBERS/formulario.html';

function estaDentroDeHorario(fecha = new Date()) {
  const hora = fecha.getHours();
  return hora >= HORA_APERTURA && hora < HORA_CIERRE;
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
      if (shouldReconnect) {
        console.log('Reintentando en 5 segundos...');
        setTimeout(startBot, 5000);
      } else {
        console.log('Sesión cerrada (logout), hay que volver a escanear el QR.');
      }
    } else if (connection === 'open') {
      isReady = true;
      latestQR = null;
      console.log('✅ Bot de WhatsApp conectado y listo para confirmar turnos.');
    }
  });
  sock.ev.on('creds.update', saveCreds);

  // ---------- Escucha de mensajes entrantes ----------
  // Hoy el bot solo mandaba mensajes; esto lo hace también RECIBIR y responder.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignorar mensajes propios y de grupos
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (!msg.message) continue;

      if (!estaDentroDeHorario()) {
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            text:
              `¡Hola! En este momento no estamos atendiendo. Nuestro horario es de ` +
              `${HORA_APERTURA}:00 a ${HORA_CIERRE}:00 hs.\n\n` +
              `Podés reservar tu turno igual desde nuestra página y te confirmamos apenas abramos:\n${LINK_RESERVAS}`,
          });
        } catch (e) {
          console.error('Error respondiendo fuera de horario:', e);
        }
      }
      // Si querés que el bot también responda algo cuando SÍ está dentro de
      // horario (ej. un saludo automático), acá es donde se agregaría.
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

async function sendMessage(numero, texto) {
  if (!sock || !isReady) {
    throw new Error('El bot todavía no está conectado a WhatsApp.');
  }
  const jid = toWhatsAppId(numero);
  await sock.sendMessage(jid, { text: texto });
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
