const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const GRAPH_VERSION = 'v21.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.warn(
    '⚠️ Faltan las variables de entorno WHATSAPP_TOKEN y/o WHATSAPP_PHONE_ID. ' +
    'El envío de mensajes va a fallar hasta que las configures en Railway.'
  );
}

// Normaliza cualquier formato de número argentino al que espera Meta:
// código de país (54) + 9 + número nacional, sin "+", sin espacios/guiones,
// y SIN el "15" viejo que mucha gente todavía escribe (prefijo de larga
// distancia para celulares, que no va en el formato internacional).
// El número nacional argentino (código de área + número local, sin el "0"
// ni el "15") siempre tiene 10 dígitos — así que si después de sacar el
// código de país y el "0" nos queda más largo que eso, es porque todavía
// tiene un "15" metido en el medio, y lo buscamos y sacamos.
function limpiarNumero(numero) {
  let n = String(numero).replace(/[^\d]/g, '');
  if (!n) return '';

  // Si ya viene con código de país, lo sacamos para trabajar sobre el
  // número nacional puro y volver a armarlo limpio al final.
  if (n.startsWith('549')) n = n.slice(3);
  else if (n.startsWith('54')) n = n.slice(2);

  if (n.startsWith('0')) n = n.slice(1); // "0" de larga distancia

  if (n.length > 10) {
    // Probamos los largos típicos de código de área (2 a 4 dígitos) para
    // encontrar dónde está metido el "15" y sacarlo.
    for (const largoArea of [2, 3, 4]) {
      if (n.slice(largoArea, largoArea + 2) === '15' && n.length - 2 === 10) {
        n = n.slice(0, largoArea) + n.slice(largoArea + 2);
        break;
      }
    }
  }

  return `549${n}`;
}

function armarLinkWhatsApp(numero, textoPredefinido) {
  const limpio = limpiarNumero(numero);
  return `https://wa.me/${limpio}?text=${encodeURIComponent(textoPredefinido)}`;
}

function delayAleatorio() {
  const ms = 2000 + Math.random() * 4000;
  return new Promise(resolve => setTimeout(resolve, ms));
}

const COOLDOWN_GLOBAL_MS = 12000;
const COOLDOWN_CONTACTO_MS = 45000;

let colaEnvios = Promise.resolve();
let ultimoEnvioGlobal = 0;
const ultimoEnvioPorNumero = {};

function encolarEnvio(numero, fn) {
  colaEnvios = colaEnvios.then(
    async () => {
      const ahora = () => Date.now();

      let espera = COOLDOWN_GLOBAL_MS - (ahora() - ultimoEnvioGlobal);
      if (espera > 0) await new Promise(r => setTimeout(r, espera));

      const ultimoAEsteNumero = ultimoEnvioPorNumero[numero] || 0;
      espera = COOLDOWN_CONTACTO_MS - (ahora() - ultimoAEsteNumero);
      if (espera > 0) {
        console.log(`⏳ Cooldown: esperando ${Math.ceil(espera / 1000)}s antes de volver a escribirle a ${numero}`);
        await new Promise(r => setTimeout(r, espera));
      }

      ultimoEnvioGlobal = Date.now();
      ultimoEnvioPorNumero[numero] = Date.now();
      return fn();
    },
    () => fn()
  );
  return colaEnvios;
}

async function enviarTextoReal(numeroDestino, texto) {
  const res = await fetch(GRAPH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numeroDestino,
      type: 'text',
      text: { body: texto },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Error ${res.status} enviando mensaje por WhatsApp`);
    err.code = data.error?.code;
    err.subcode = data.error?.error_subcode;
    throw err;
  }
  return data;
}

async function sendMessage(numero, texto) {
  const numeroLimpio = limpiarNumero(numero);
  if (!numeroLimpio) throw new Error('Número de WhatsApp inválido.');

  try {
    await encolarEnvio(numeroLimpio, async () => {
      await delayAleatorio();
      console.log(`📤 Enviando mensaje a: ${numeroLimpio}`);
      await enviarTextoReal(numeroLimpio, texto);
      console.log(`✅ Mensaje entregado a ${numeroLimpio}`);
    });
    return { enviado: true, jid: numeroLimpio };
  } catch (e) {
    if (e.code === 131047) {
      console.log(`⏸️ No se manda a ${numeroLimpio}: ventana de 24hs cerrada (el cliente no nos escribió recientemente).`);
      return {
        enviado: false,
        jid: numeroLimpio,
        whatsappLink: armarLinkWhatsApp(numero, 'Hola! Quiero confirmar mi turno en AMB Barbers 💈'),
      };
    }
    console.error(`❌ Error enviando a ${numeroLimpio}:`, e.message);
    throw e;
  }
}

module.exports = {
  sendMessage,
  armarLinkWhatsApp,
  limpiarNumero,
};
