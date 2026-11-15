require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { sendMessage, armarLinkWhatsApp, limpiarNumero, marcarComoLeido } = require('./whatsapp-cloud');
// data.js exporta SERVICIOS y BARBEROS como arrays (así los necesita el
// formulario web, que carga el mismo archivo directo en el navegador).
// Acá los convertimos a objetos indexados por id, que es como los usa el
// resto de este archivo (SERVICIOS[servicio], BARBEROS[barbero]).
const { SERVICIOS: SERVICIOS_LISTA, BARBEROS: BARBEROS_LISTA } = require('./data');
const SERVICIOS = {};
SERVICIOS_LISTA.forEach(s => { SERVICIOS[s.id] = s; });
const BARBEROS = {};
BARBEROS_LISTA.forEach(b => { BARBEROS[b.id] = b.nombre; });

process.on('uncaughtException', (err) => {
  console.error('⚠️ Error no capturado (el servidor sigue funcionando):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Promesa rechazada sin manejar (el servidor sigue funcionando):', reason);
});

const app = express();
// Railway está detrás de un proxy: sin esto todas las visitas parecerían la misma IP.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({
  limit: '5mb', // Meta puede agrupar muchas notificaciones en un mismo webhook.
  // Conservamos el cuerpo original para validar la firma HMAC de Meta.
  verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); },
}));

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TURNOS_FILE = path.join(DATA_DIR, 'turnos.json');
if (!fs.existsSync(TURNOS_FILE)) fs.writeFileSync(TURNOS_FILE, '[]');

const BLOQUEOS_FILE = path.join(DATA_DIR, 'bloqueos.json');
if (!fs.existsSync(BLOQUEOS_FILE)) fs.writeFileSync(BLOQUEOS_FILE, '[]');

// ---------- Registro de mensajes enviados ----------
// Con la API oficial no hay ningún WhatsApp normal donde ver "lo que se
// mandó" — este archivo es el reemplazo: cada vez que el bot intenta
// mandar algo (confirmación, recordatorio, aviso al dueño, respuesta del
// webhook), queda anotado acá, se haya entregado o no.
const MENSAJES_FILE = path.join(DATA_DIR, 'mensajes.json');
if (!fs.existsSync(MENSAJES_FILE)) fs.writeFileSync(MENSAJES_FILE, '[]');
// IDs de mensajes entrantes ya procesados: evita responder dos veces si Meta
// reintenta una notificación que no recibió el acuse correctamente.
const MENSAJES_RECIBIDOS_FILE = path.join(DATA_DIR, 'mensajes-recibidos.json');
if (!fs.existsSync(MENSAJES_RECIBIDOS_FILE)) fs.writeFileSync(MENSAJES_RECIBIDOS_FILE, '[]');
const MAX_MENSAJES_GUARDADOS = 500;
const MAX_MENSAJES_RECIBIDOS = 2000; // para que el archivo no crezca sin límite

function leerMensajes() {
  return JSON.parse(fs.readFileSync(MENSAJES_FILE, 'utf-8'));
}
function guardarMensajes(mensajes) {
  const recortados = mensajes.slice(-MAX_MENSAJES_GUARDADOS);
  fs.writeFileSync(MENSAJES_FILE, JSON.stringify(recortados, null, 2));
}
function mensajeEntranteYaProcesado(messageId) {
  if (!messageId) return null;
  try {
    const ids = JSON.parse(fs.readFileSync(MENSAJES_RECIBIDOS_FILE, 'utf-8'));
    if (!Array.isArray(ids)) throw new Error('El registro de mensajes recibidos no es una lista válida.');
    return ids.includes(messageId);
  } catch (e) {
    console.error('⚠️ No se pudo comprobar el ID entrante:', e.message);
    return null;
  }
}

function registrarMensajeEntranteUnico(messageId) {
  if (!messageId) return null;
  try {
    const ids = JSON.parse(fs.readFileSync(MENSAJES_RECIBIDOS_FILE, 'utf-8'));
    if (!Array.isArray(ids)) throw new Error('El registro de mensajes recibidos no es una lista válida.');
    if (ids.includes(messageId)) return false;
    ids.push(messageId);
    fs.writeFileSync(MENSAJES_RECIBIDOS_FILE, JSON.stringify(ids.slice(-MAX_MENSAJES_RECIBIDOS)));
    return true;
  } catch (e) {
    console.error('⚠️ No se pudo guardar el ID entrante:', e.message);
    return null;
  }
}

function registrarMensaje({ numero, texto, tipo, enviado, error, waMessageId }) {
  try {
    const mensajes = leerMensajes();
    mensajes.push({
      fecha: new Date().toISOString(),
      numero,
      texto,
      tipo, // 'confirmacion' | 'recordatorio' | 'aviso_dueno' | 'webhook'
      enviado, // true = la API de Meta ACEPTÓ mandarlo (no confirma entrega real todavía)
      error: error || null,
      waMessageId: waMessageId || null,
      // estadoReal se actualiza después, cuando Meta avisa por el webhook si
      // se entregó de verdad o si falló. Hasta que llegue ese aviso, queda
      // en null (no confundir con 'enviado', que solo dice que la API lo
      // recibió, no que le llegó al celular del cliente).
      estadoReal: null,
    });
    guardarMensajes(mensajes);
  } catch (e) {
    console.error('⚠️ No se pudo registrar el mensaje en el log (no afecta el envío):', e.message);
  }
}

// Se llama desde el webhook cuando Meta manda una actualización de estado
// real (sent/delivered/read/failed) para un mensaje que mandamos antes.
// Busca ese mensaje en el log por su waMessageId y le actualiza el estado
// de verdad, para que el panel deje de mostrar "Entregado" solo porque la
// API lo aceptó, y muestre lo que realmente pasó.
function actualizarEstadoRealMensaje(waMessageId, estado, errorDetalle) {
  try {
    const mensajes = leerMensajes();
    const encontrado = mensajes.find(m => m.waMessageId === waMessageId);
    if (!encontrado) return; // puede ser de antes de este cambio, o ya se recortó del historial
    encontrado.estadoReal = estado; // 'sent' | 'delivered' | 'read' | 'failed'
    if (estado === 'failed') {
      encontrado.enviado = false;
      encontrado.error = errorDetalle || 'Meta reportó que no se pudo entregar.';
    }
    guardarMensajes(mensajes);
    console.log(`📬 Estado real actualizado para ${waMessageId}: ${estado}`);
  } catch (e) {
    console.error('⚠️ No se pudo actualizar el estado real del mensaje:', e.message);
  }
}

// Envoltorio de sendMessage: todo el resto del archivo llama a ESTA función
// en vez de sendMessage directo, así queda registrado siempre, sin
// olvidarse en ningún lugar donde se manda algo.
async function enviarYRegistrar(numero, texto, tipo) {
  try {
    const resultado = await sendMessage(numero, texto);
    registrarMensaje({
      numero, texto, tipo,
      enviado: resultado.enviado,
      error: resultado.enviado ? null : 'ventana de 24hs cerrada',
      waMessageId: resultado.waMessageId,
    });
    return resultado;
  } catch (e) {
    registrarMensaje({ numero, texto, tipo, enviado: false, error: e.message });
    throw e;
  }
}

const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP;
const PANEL_KEY = process.env.PANEL_KEY || 'cambiar-esta-clave';

// ==================== Cumplimiento de las políticas de WhatsApp ====================
// Política de mensajería de WhatsApp Business (resumen de lo que acá se cumple):
//  - Solo se escribe a quien dio su número Y aceptó recibir mensajes (casilla del formulario).
//  - Fuera de las 24hs desde el último mensaje del cliente solo se puede iniciar con plantillas
//    aprobadas; por eso los recordatorios solo salen si el cliente nos escribió hace menos de 24hs.
//  - Se respeta el pedido de baja (BAJA) y se explica cómo darse de baja.
//  - Las respuestas automáticas indican cómo hablar con una persona.

// Interruptor de emergencia: poné RECORDATORIOS_ACTIVOS=false en Railway y el bot no manda
// NADA por iniciativa propia (solo contesta cuando el cliente escribe).
const RECORDATORIOS_ACTIVOS = String(process.env.RECORDATORIOS_ACTIVOS ?? 'true').trim().toLowerCase() !== 'false';
// Máximo de intentos por recordatorio. Si la variable está mal configurada,
// se usa el valor seguro por defecto; además se limita a 5 para evitar bucles.
const intentosRecordatorioConfig = Number.parseInt(process.env.MAX_INTENTOS_RECORDATORIO ?? '2', 10);
const MAX_INTENTOS_RECORDATORIO = Number.isFinite(intentosRecordatorioConfig)
  ? Math.max(0, Math.min(5, intentosRecordatorioConfig))
  : 2;
// Teléfono para hablar con una persona (se muestra en los mensajes automáticos).
const TELEFONO_CONTACTO_HUMANO = process.env.TELEFONO_CONTACTO || '+54 9 2643 21-2176';

const OPTOUT_FILE = path.join(DATA_DIR, 'optout.json');
if (!fs.existsSync(OPTOUT_FILE)) fs.writeFileSync(OPTOUT_FILE, '{}');

function normalizarTexto(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function esPedidoDeBaja(texto) {
  const t = normalizarTexto(texto);
  if (['baja', 'stop', 'parar', 'no molestar', 'desuscribir'].includes(t)) return true;
  return /\b(dejar de recibir|no quiero recibir|no quiero mas mensajes|no me (escribas|escriban|mandes|manden|molestes|molesten))\b/.test(t);
}
function esPedidoDeAlta(texto) {
  return normalizarTexto(texto) === 'alta';
}
function estaDadoDeBaja(numero) {
  try {
    const lista = JSON.parse(fs.readFileSync(OPTOUT_FILE, 'utf-8'));
    if (!lista || typeof lista !== 'object' || Array.isArray(lista)) {
      throw new Error('El archivo de bajas no contiene un objeto válido.');
    }
    return !!lista[limpiarNumero(numero)];
  } catch (e) {
    // Ante cualquier error, fallar cerrado: nunca interpretar un fallo de
    // lectura como consentimiento para enviar mensajes.
    console.error('⚠️ No se pudo comprobar la baja; se bloquean los envíos:', e.message);
    return true;
  }
}
function guardarBaja(numero, dada) {
  const lista = JSON.parse(fs.readFileSync(OPTOUT_FILE, 'utf-8'));
  if (!lista || typeof lista !== 'object' || Array.isArray(lista)) {
    throw new Error('El archivo de bajas no contiene un objeto válido.');
  }
  if (dada) lista[limpiarNumero(numero)] = new Date().toISOString();
  else delete lista[limpiarNumero(numero)];
  // Si no se puede persistir la baja/alta, propagar el error. No confirmar
  // al cliente un cambio que en realidad no quedó guardado.
  fs.writeFileSync(OPTOUT_FILE, JSON.stringify(lista, null, 2));
}

// ==================== Protección de la cuenta de WhatsApp Business ====================
// Meta bloquea las cuentas que le escriben a gente que no lo pidió. Estas
// piezas evitan eso: (1) solo se manda algo proactivo a quien nos escribió
// en las últimas 24hs, (2) se limita cuántas reservas se pueden cargar para
// que nadie use el formulario para escribirle a números ajenos, y (3) se
// guardan los avisos que manda Meta sobre el estado de la cuenta.
const VENTANAS_FILE = path.join(DATA_DIR, 'ventanas.json');
const ALERTAS_META_FILE = path.join(DATA_DIR, 'alertas-meta.json');
if (!fs.existsSync(VENTANAS_FILE)) fs.writeFileSync(VENTANAS_FILE, '{}');
if (!fs.existsSync(ALERTAS_META_FILE)) fs.writeFileSync(ALERTAS_META_FILE, '[]');

// Meta deja contestar libremente hasta 24hs después del último mensaje del
// cliente. Usamos 23hs para tener un margen y no pasarnos por minutos.
const VENTANA_CLIENTE_MS = 23 * 60 * 60 * 1000;

function registrarEntrante(numero) {
  try {
    const ventanas = JSON.parse(fs.readFileSync(VENTANAS_FILE, 'utf-8'));
    ventanas[limpiarNumero(numero)] = new Date().toISOString();
    const limite = Date.now() - 3 * 24 * 60 * 60 * 1000; // no guardar historia vieja
    for (const n of Object.keys(ventanas)) {
      if (new Date(ventanas[n]).getTime() < limite) delete ventanas[n];
    }
    fs.writeFileSync(VENTANAS_FILE, JSON.stringify(ventanas, null, 2));
  } catch (e) {
    console.error('No se pudo registrar el mensaje entrante:', e.message);
  }
}

function ventanaAbierta(numero) {
  try {
    const ventanas = JSON.parse(fs.readFileSync(VENTANAS_FILE, 'utf-8'));
    const ultimo = ventanas[limpiarNumero(numero)];
    return !!ultimo && Date.now() - new Date(ultimo).getTime() < VENTANA_CLIENTE_MS;
  } catch (e) {
    return false; // ante la duda, no mandar nada
  }
}

// Límites de reservas (contra uso abusivo del formulario)
const MAX_RESERVAS_POR_NUMERO_24H = 3;
const MAX_TURNOS_FUTUROS_POR_NUMERO = 4;
const LIMITE_IP_MAX = 10;
const LIMITE_IP_VENTANA_MS = 60 * 60 * 1000;
const intentosPorIp = new Map();
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, marcas] of intentosPorIp) {
    const vigentes = marcas.filter(t => ahora - t < LIMITE_IP_VENTANA_MS);
    if (vigentes.length) intentosPorIp.set(ip, vigentes); else intentosPorIp.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// Si por algún motivo solo vemos una IP interna (de la red de Railway) no
// podemos distinguir clientes entre sí: en ese caso NO se limita por IP,
// para no bloquear a todos por error. Los celulares comparten IPs (CGNAT),
// por eso el límite por IP es generoso.
function esIpPrivada(ip) {
  const v4 = String(ip).replace(/^::ffff:/, '');
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(v4)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4)) return true;
  return /^(::1|f[cd][0-9a-f]{2}:|fe80:)/i.test(String(ip));
}

function superaLimiteIp(ip) {
  if (!ip || esIpPrivada(ip)) return false;
  const ahora = Date.now();
  const vigentes = (intentosPorIp.get(ip) || []).filter(t => ahora - t < LIMITE_IP_VENTANA_MS);
  vigentes.push(ahora);
  intentosPorIp.set(ip, vigentes);
  return vigentes.length > LIMITE_IP_MAX;
}

// Avisos que manda Meta sobre la cuenta (violaciones, calidad, bloqueos).
// Hay que suscribir estos campos en el panel de Meta (ver instrucciones).
const CAMPOS_ALERTA_META = ['account_update', 'account_alerts', 'phone_number_quality_update', 'account_review_update'];

function resumirAlertaMeta(v = {}) {
  const partes = [];
  if (v.event) partes.push(`evento ${v.event}`);
  if (v.alert_type) partes.push(`tipo ${v.alert_type}`);
  if (v.alert_severity) partes.push(`gravedad ${v.alert_severity}`);
  if (v.alert_description) partes.push(v.alert_description);
  if (v.violation_info?.violation_type) partes.push(`infracción ${v.violation_info.violation_type}`);
  if (v.ban_info?.waba_ban_state) partes.push(`estado ${v.ban_info.waba_ban_state}`);
  if (v.current_limit) partes.push(`límite ${v.current_limit}`);
  if (v.decision) partes.push(`decisión ${v.decision}`);
  return partes.join(' · ') || JSON.stringify(v).slice(0, 300);
}

async function procesarAlertaMeta(campo, value) {
  const resumen = resumirAlertaMeta(value);
  console.log(`🚨 Alerta de Meta (${campo}): ${resumen}`);
  try {
    const alertas = JSON.parse(fs.readFileSync(ALERTAS_META_FILE, 'utf-8'));
    alertas.push({ fecha: new Date().toISOString(), campo, resumen, detalle: value });
    fs.writeFileSync(ALERTAS_META_FILE, JSON.stringify(alertas.slice(-100), null, 2));
  } catch (e) {
    console.error('No se pudo guardar la alerta de Meta:', e.message);
  }
  // Aviso al dueño (puede no llegar si su ventana de 24hs está cerrada;
  // lo seguro es mirar /api/alertas-meta o los logs).
  if (OWNER_WHATSAPP && ventanaAbierta(OWNER_WHATSAPP)) {
    try {
      await enviarYRegistrar(OWNER_WHATSAPP, `🚨 Meta avisó algo de la cuenta de WhatsApp (${campo}): ${resumen}. Revisá Business Support Home.`, 'alerta_meta');
    } catch (e) { /* mejor esfuerzo */ }
  }
}

function leerTurnos() {
  return JSON.parse(fs.readFileSync(TURNOS_FILE, 'utf-8'));
}
function guardarTurno(turno) {
  const turnos = leerTurnos();
  turnos.push(turno);
  fs.writeFileSync(TURNOS_FILE, JSON.stringify(turnos, null, 2));
}
function guardarTodosLosTurnos(turnos) {
  fs.writeFileSync(TURNOS_FILE, JSON.stringify(turnos, null, 2));
}

let colaTurnos = Promise.resolve();
function conLockDeTurnos(fn) {
  const resultado = colaTurnos.then(fn, fn);
  colaTurnos = resultado.catch(() => {});
  return resultado;
}

function leerBloqueos() {
  return JSON.parse(fs.readFileSync(BLOQUEOS_FILE, 'utf-8'));
}
function guardarBloqueos(bloqueos) {
  fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify(bloqueos, null, 2));
}

function generarHorariosEntre(horaInicio, horaFin) {
  const horarios = [];
  const [hIni, mIni] = horaInicio.split(':').map(Number);
  const [hFin, mFin] = horaFin.split(':').map(Number);
  let t = hIni * 60 + mIni;
  const fin = hFin * 60 + mFin;
  while (t < fin) {
    const hh = String(Math.floor(t / 60)).padStart(2, '0');
    const mm = String(t % 60).padStart(2, '0');
    horarios.push(`${hh}:${mm}`);
    t += 30;
  }
  return horarios;
}

function formatearFecha(diaISO) {
  const [y, m, d] = diaISO.split('-');
  return `${d}/${m}/${y}`;
}

function fechaHoraDelTurno(turno) {
  return new Date(`${turno.dia}T${turno.horario}:00-03:00`);
}

// Cuánto antes del turno avisar, según cuán ajustada fue la reserva.
function minutosDeAvisoPara(turno) {
  const horaTurno = fechaHoraDelTurno(turno);
  const anticipacionTotal = (horaTurno - new Date(turno.creado)) / 60000;
  if (anticipacionTotal > 60) return 30;
  if (anticipacionTotal > 20) return 20;
  return 5;
}

// El recordatorio solo aplica si el turno se reservó con 24hs o menos de
// anticipación (osea, entre el momento de reservar y la hora del turno no
// pasan más de 24hs). Si alguien reserva con más anticipación que eso
// (ej: para la semana que viene), no le llega recordatorio.
function correspondeRecordatorio(turno) {
  const horaTurno = fechaHoraDelTurno(turno);
  const anticipacionTotal = (horaTurno - new Date(turno.creado)) / 3600000; // en horas
  return anticipacionTotal <= 24;
}

function construirMensajeConfirmacion(turno) {
  const fechaLinda = formatearFecha(turno.dia);
  return (
    `✅ *Turno confirmado - AMB BARBERS*\n\n` +
    `Hola ${turno.nombre}! Tu turno quedó agendado:\n\n` +
    `💈 Barbero: ${turno.barbero}\n` +
    `✂️ Servicio: ${turno.servicio}\n` +
    `📅 Día: ${fechaLinda}\n` +
    `🕐 Hora: ${turno.horario} hs\n` +
    `💰 Precio: ${turno.precio}\n\n` +
    `📍 Calle 9 de Julio, entre Mitre y Av. Ramón Barrera, Santa Rosa - 25 de Mayo, San Juan.\n\n` +
    `Te recomendamos llegar 5 minutos antes para disfrutar la experiencia completa.\n\n` +
    `¿Dudas o cambios? Escribinos o llamanos al ${TELEFONO_CONTACTO_HUMANO}.\n\n` +
    `¡Nos vemos pronto!`
  );
}

// ---------- Aviso de fidelidad ----------
// El aviso NO depende de que el cliente reserve de nuevo: apenas el corte
// que desbloquea algo queda marcado ✓ en el panel (ver /completar más
// abajo), se calcula el hito y se guarda EN ESE TURNO (hitoFidelidad +
// hitoFidelidadAvisado:false). Después, la PRÓXIMA vez que el cliente le
// escriba al bot por cualquier motivo (no necesariamente para confirmar
// una reserva nueva), el webhook revisa si tiene algún hito pendiente de
// avisar y se lo suma a la respuesta — y recién ahí lo marca como avisado.
// Así no se pierde el aviso aunque no reserve enseguida.
const FIDELIDAD_FECHA_INICIO = '2026-09-01';
const CORTES_PARA_ACTIVAR_TARJETA = 1; // igual que en panel.html — no tocar sin cambiar los dos

// MIGRACIÓN (para que los clientes que ya venían no pierdan su progreso):
// antes la tarjeta se activaba al 3er corte. Los clientes que ya tenían 3 o
// más cortes ANTES de esta fecha conservan exactamente su lugar en la
// tarjeta (se les descuentan los 2 cortes de diferencia de la activación
// vieja). Los demás usan la regla nueva: se activa al 1er corte.
// Tiene que ser igual en panel.html. Poné acá el día SIGUIENTE a cuando
// subas este cambio.
const CORTES_ACTIVACION_ANTERIOR = 3;
const FIDELIDAD_FECHA_CAMBIO = '2026-11-05';

// Interruptor único para apagar TODO lo de la tarjeta de fidelidad.
// Para reactivarla: FIDELIDAD_TARJETA_ACTIVA = true.
const FIDELIDAD_TARJETA_ACTIVA = true;

// Cortes "efectivos" de un cliente para la tarjeta: los confirmados desde
// FIDELIDAD_FECHA_INICIO, menos el ajuste de la migración (ver arriba).
function cortesEfectivosDeTurnos(turnos, numeroNormalizado) {
  const propios = turnos.filter(t =>
    t.completado &&
    limpiarNumero(t.whatsapp) === numeroNormalizado &&
    t.dia >= FIDELIDAD_FECHA_INICIO
  );
  const antesDelCambio = propios.filter(t => t.dia < FIDELIDAD_FECHA_CAMBIO).length;
  const ajuste = antesDelCambio >= CORTES_ACTIVACION_ANTERIOR
    ? CORTES_ACTIVACION_ANTERIOR - CORTES_PARA_ACTIVAR_TARJETA
    : 0;
  return propios.length - ajuste;
}

function contarCortesConfirmados(numeroCliente) {
  return cortesEfectivosDeTurnos(leerTurnos(), limpiarNumero(numeroCliente));
}

// totalCortes = cuántos cortes tiene el cliente CONTANDO el que se acaba de
// marcar ✓. Devuelve qué hito disparó ese corte puntual, o null si ninguno.
function calcularHitoDeCorte(totalCortes) {
  if (totalCortes === CORTES_PARA_ACTIVAR_TARJETA) return 'activacion';
  if (totalCortes < CORTES_PARA_ACTIVAR_TARJETA) return null;
  const cortesParaCiclo = totalCortes - CORTES_PARA_ACTIVAR_TARJETA;
  const resto = cortesParaCiclo % 10;
  if (resto === 5) return '50';
  if (resto === 0 && cortesParaCiclo > 0) return 'gratis';
  return null;
}

function textoHitoFidelidad(hito) {
  if (hito === 'activacion') {
    return `🎉 ¡Activaste tu *tarjeta de fidelidad*! Cada 10 cortes: 50% off en el 5° y un corte GRATIS en el 10°. Dudas: ${TELEFONO_CONTACTO_HUMANO}.`;
  }
  if (hito === '50') {
    return `🎁 ¡Tu próximo turno tiene *50% de descuento* (en cualquier servicio)! Se lo mostrás al barbero. Dudas: ${TELEFONO_CONTACTO_HUMANO}.`;
  }
  if (hito === 'gratis') {
    return `🎁 ¡Tu próximo turno es *GRATIS*! Completaste tu tarjeta de fidelidad. Dudas: ${TELEFONO_CONTACTO_HUMANO}.`;
  }
  return '';
}

// Aviso de fidelidad que viaja DENTRO de la confirmación del turno (sin
// esperar el tick ni que el cliente escriba de nuevo). Cuenta solo cortes
// ya confirmados ✓ en el panel, y dice dos cosas posibles:
//  1) Si el cliente YA ganó un premio con un corte anterior, este turno lo usa.
//  2) Si ESTE turno lo haría ganar algo (activar tarjeta, 50%, gratis),
//     se lo avisa en condicional: recién cuenta cuando venga (tick del barbero).
function textoAvisoAnticipado(numeroCliente, consentimientoFidelidad) {
  if (!FIDELIDAD_TARJETA_ACTIVA || consentimientoFidelidad !== true) return '';
  const cortes = contarCortesConfirmados(numeroCliente);
  const lineas = [];

  const premioGanado = calcularHitoDeCorte(cortes);
  if (premioGanado === '50') {
    lineas.push(`🎁 Este turno tiene *50% de descuento* (en cualquier servicio) por tu tarjeta de fidelidad. Se lo mostrás al barbero.`);
  } else if (premioGanado === 'gratis') {
    lineas.push(`🎁 Este turno es *GRATIS* por tu tarjeta de fidelidad. Se lo mostrás al barbero.`);
  }

  const siViene = calcularHitoDeCorte(cortes + 1);
  if (siViene === 'activacion') {
    lineas.push(`🎉 Con este corte activás tu *tarjeta de fidelidad*. Cuando vengas te la confirmamos.`);
  } else if (siViene === '50') {
    lineas.push(`🎁 Con este corte ganás *50% de descuento* para tu próximo turno (en cualquier servicio). Se confirma cuando vengas.`);
  } else if (siViene === 'gratis') {
    lineas.push(`🎁 Con este corte completás tu tarjeta: tu próximo turno es *GRATIS*. Se confirma cuando vengas.`);
  }

  return lineas.join('\n\n');
}

// Busca si este número tiene algún corte con un hito ganado y todavía sin
// avisar (puede haber como mucho uno pendiente a la vez, normalmente).
function buscarHitoPendiente(numeroCliente) {
  const numeroNormalizado = limpiarNumero(numeroCliente);
  return leerTurnos().find(t =>
    t.hitoFidelidad && !t.hitoFidelidadAvisado &&
    t.consentimientoFidelidadWhatsapp?.aceptado === true &&
    limpiarNumero(t.whatsapp) === numeroNormalizado
  ) || null;
}

function marcarHitoAvisado(turnoId) {
  const turnos = leerTurnos();
  const t = turnos.find(x => x.id === turnoId);
  if (t) {
    t.hitoFidelidadAvisado = true;
    guardarTodosLosTurnos(turnos);
  }
}

// Compara el número que llega de Meta (mensaje.from) contra los guardados
// en los turnos, pasando LOS DOS por limpiarNumero antes de comparar. Sin
// esto, un contacto nuevo (primera vez que le escribe al bot) puede llegar
// en un formato levemente distinto (ej: sin el "9") al que ya está
// normalizado en turnos.json, y el matcheo fallaba en el primer mensaje —
// para recién funcionar en el segundo, cuando Meta ya "conoce" el contacto
// y lo manda completo.
// Además, ignora turnos que ya se marcaron como completados en el panel o
// que ya pasaron de horario — si un cliente escribe después de eso, no
// tiene sentido volver a mandarle una confirmación vieja.
function buscarTurnoPorNumero(numeroCliente) {
  const ahora = new Date();
  const numeroClienteNormalizado = limpiarNumero(numeroCliente);
  const turnos = leerTurnos()
    .filter(t => !t.completado && fechaHoraDelTurno(t) > ahora)
    .sort((a, b) => new Date(b.creado) - new Date(a.creado));
  return turnos.find(t => limpiarNumero(t.whatsapp) === numeroClienteNormalizado) || null;
}

app.post('/api/reservar', async (req, res) => {
  try {
    const { nombre, whatsapp, barbero, servicio, dia, horario, aceptaWhatsapp, aceptaFidelidadWhatsapp } = req.body;

    if (!nombre || !whatsapp || !barbero || !servicio || !dia || !horario) {
      return res.status(400).json({ error: 'Faltan datos de la reserva.' });
    }

    if (superaLimiteIp(req.ip)) {
      return res.status(429).json({ error: 'Hiciste muchas reservas seguidas. Probá de nuevo en un rato o escribinos por WhatsApp.' });
    }

    // Consentimiento: hay que confirmar que el número es propio y aceptar
    // recibir mensajes. Queda guardado en el turno como constancia.
    if (aceptaWhatsapp !== true) {
      return res.status(400).json({ error: 'Para reservar tenés que confirmar que el número es tuyo y aceptar recibir mensajes por WhatsApp.' });
    }
    const digitos = String(whatsapp).replace(/\D/g, '');
    if (digitos.length < 8 || digitos.length > 15) {
      return res.status(400).json({ error: 'El número de WhatsApp no parece válido. Revisalo, por favor.' });
    }

    const servicioInfo = SERVICIOS[servicio];
    const barberoNombre = BARBEROS[barbero];
    if (!servicioInfo || !barberoNombre) {
      return res.status(400).json({ error: 'Servicio o barbero inválido.' });
    }

    const resultadoReserva = await conLockDeTurnos(() => {
      const turnosExistentes = leerTurnos();

      // Tope de reservas por número: evita que se use el formulario para
      // cargar en cadena números ajenos.
      const numeroNuevo = limpiarNumero(whatsapp);
      const delNumero = turnosExistentes.filter(t => limpiarNumero(t.whatsapp) === numeroNuevo);
      const ultimas24h = delNumero.filter(t => Date.now() - new Date(t.creado).getTime() < 24 * 60 * 60 * 1000).length;
      const futuros = delNumero.filter(t => !t.completado && fechaHoraDelTurno(t) > new Date()).length;
      if (ultimas24h >= MAX_RESERVAS_POR_NUMERO_24H || futuros >= MAX_TURNOS_FUTUROS_POR_NUMERO) {
        return { error: 'Este número ya tiene varias reservas. Si necesitás más turnos, escribinos por WhatsApp.', status: 429 };
      }

      const yaOcupado = turnosExistentes.some(
        t => t.dia === dia && t.horario === horario && t.barbero === barberoNombre
      );
      if (yaOcupado) {
        return { error: `${barberoNombre} ya tiene un turno ocupado a esa hora. Elegí otro horario.` };
      }

      const bloqueos = leerBloqueos();
      const estaBloqueado = bloqueos.some(
        b => b.dia === dia && b.horario === horario && (b.barbero === 'Todos' || b.barbero === barbero)
      );
      if (estaBloqueado) {
        return { error: 'Ese horario no está disponible. Elegí otro.' };
      }

      const turno = {
        id: Date.now().toString(),
        nombre, whatsapp, barbero: barberoNombre,
        servicio: servicioInfo.nombre, precio: servicioInfo.precio,
        dia, horario,
        creado: new Date().toISOString(),
        recordatorioEnviado: false,
        completado: false,
        consentimientoWhatsapp: { aceptado: true, fecha: new Date().toISOString() },
        consentimientoFidelidadWhatsapp: { aceptado: aceptaFidelidadWhatsapp === true, fecha: new Date().toISOString() },
      };
      guardarTurno(turno);
      return { turno };
    });

    if (resultadoReserva.error) {
      return res.status(resultadoReserva.status || 409).json({ error: resultadoReserva.error });
    }
    const turno = resultadoReserva.turno;

    const fechaLinda = formatearFecha(dia);

    // La confirmación al cliente SOLO se manda cuando el bot lee su
    // mensaje real (webhook, más abajo) — nunca antes. Un intento
    // automático acá, antes de que escriba, siempre fallaría con "Re-
    // engagement message" (ventana de 24hs cerrada) para cualquier
    // cliente nuevo, así que no tiene sentido intentarlo.
    let whatsappLink = armarLinkWhatsApp(whatsapp, `Hola! Quiero confirmar mi turno para ${fechaLinda} a las ${horario} hs 💈`);
    let mensajeEnviado = false;

    // El aviso al dueño solo se manda si él escribió al bot en las últimas 24hs; si no, WhatsApp
    // lo rechazaría (no se puede iniciar sin plantilla). Las reservas se ven siempre en el panel.
    if (OWNER_WHATSAPP && ventanaAbierta(OWNER_WHATSAPP)) {
      try {
        const mensajeDueno =
          `📌 Nueva reserva confirmada automáticamente:\n` +
          `${nombre} (${whatsapp})\n${barberoNombre} - ${servicioInfo.nombre}\n${fechaLinda} ${horario} hs`;
        await enviarYRegistrar(OWNER_WHATSAPP, mensajeDueno, 'aviso_dueno');
      } catch (e) {
        console.error('⚠️ No se pudo notificar al dueño (número no disponible o suspendido):', e.message);
      }
    }

    res.json({ ok: true, turno, mensajeEnviado, whatsappLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno al procesar la reserva.' });
  }
});

// Endpoint público (sin clave): consulta el estado de la tarjeta de
// fidelidad de un cliente por su número. Usa EXACTAMENTE la misma cuenta
// que mensajeHitoFidelidad (contarCortesConfirmados), así que ya respeta
// solo también la fecha de corte (FIDELIDAD_FECHA_INICIO) — no hace falta
// tocar nada más acá para que el arranque en cero sea consistente.
app.get('/api/fidelidad', (req, res) => {
  const { telefono } = req.query;
  if (!telefono) {
    return res.status(400).json({ error: 'Falta el número de teléfono.' });
  }
  try {
    const cortes = contarCortesConfirmados(telefono);
    const activo = cortes >= CORTES_PARA_ACTIVAR_TARJETA;

    if (!activo) {
      return res.json({
        cortes,
        activo,
        resto: cortes, // posición a resaltar en la grilla mientras se activa
        proximoPremio: null,
        faltan: CORTES_PARA_ACTIVAR_TARJETA - cortes,
        cortesParaActivar: CORTES_PARA_ACTIVAR_TARJETA,
        premioDisponible: null,
      });
    }

    const cortesParaCiclo = cortes - CORTES_PARA_ACTIVAR_TARJETA;
    const restoCiclo = cortesParaCiclo % 10;

    // Cuando completa la tarjeta (restoCiclo vuelve a 0) los casilleros se
    // despintan solos y arranca otra vuelta, sin volver a "desbloquear" nada.
    // El corte gratis que ganó queda avisado en premioDisponible.
    let proximoPremio, faltan, resto;
    if (restoCiclo < 5) {
      resto = restoCiclo;
      proximoPremio = '50% de descuento';
      faltan = 5 - restoCiclo;
    } else {
      resto = restoCiclo;
      proximoPremio = 'un corte gratis';
      faltan = 10 - restoCiclo;
    }

    // Premio que el cliente tiene listo para usar AHORA: el que ganó con su
    // último corte confirmado ('activacion' | '50' | 'gratis' | null).
    const premioDisponible = calcularHitoDeCorte(cortes);

    res.json({ cortes, activo, resto, proximoPremio, faltan, premioDisponible, cortesParaActivar: CORTES_PARA_ACTIVAR_TARJETA });
  } catch (e) {
    console.error('Error consultando fidelidad:', e);
    res.status(500).json({ error: 'No se pudo consultar la tarjeta.' });
  }
});

app.get('/api/ocupados', (req, res) => {
  const { dia, barbero } = req.query;
  if (!dia || !barbero) {
    return res.status(400).json({ error: 'Faltan parámetros dia y barbero.' });
  }
  const barberoNombre = BARBEROS[barbero];
  if (!barberoNombre) {
    return res.status(400).json({ error: 'Barbero inválido.' });
  }
  try {
    const turnos = leerTurnos();
    const ocupadosPorTurno = turnos
      .filter(t => t.dia === dia && t.barbero === barberoNombre)
      .map(t => t.horario);

    const bloqueos = leerBloqueos();
    const ocupadosPorBloqueo = bloqueos
      .filter(b => b.dia === dia && (b.barbero === 'Todos' || b.barbero === barbero))
      .map(b => b.horario);

    const ocupados = [...new Set([...ocupadosPorTurno, ...ocupadosPorBloqueo])];
    res.json({ ocupados });
  } catch (e) {
    console.error('Error consultando horarios ocupados:', e);
    res.status(500).json({ error: 'No se pudo consultar la disponibilidad.' });
  }
});

app.get('/api/turnos', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    res.json(leerTurnos());
  } catch (e) {
    console.error('Error leyendo turnos:', e);
    res.status(500).json({ error: 'No se pudieron leer los turnos.' });
  }
});

app.get('/api/mensajes', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    // Más recientes primero
    const mensajes = leerMensajes().slice().reverse();
    res.json(mensajes);
  } catch (e) {
    console.error('Error leyendo mensajes:', e);
    res.status(500).json({ error: 'No se pudieron leer los mensajes.' });
  }
});

app.get('/api/alertas-meta', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(ALERTAS_META_FILE, 'utf-8')).reverse());
  } catch (e) {
    res.status(500).json({ error: 'No se pudieron leer las alertas.' });
  }
});

app.get('/api/bloqueos', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    res.json(leerBloqueos());
  } catch (e) {
    console.error('Error leyendo bloqueos:', e);
    res.status(500).json({ error: 'No se pudieron leer los bloqueos.' });
  }
});

app.post('/api/bloqueos', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    const { dia, barbero, horaInicio, horaFin } = req.body;
    if (!dia || !barbero || !horaInicio || !horaFin) {
      return res.status(400).json({ error: 'Faltan datos del bloqueo.' });
    }
    if (horaFin <= horaInicio) {
      return res.status(400).json({ error: 'El horario "hasta" tiene que ser posterior al "desde".' });
    }

    const horarios = generarHorariosEntre(horaInicio, horaFin);
    if (horarios.length === 0) {
      return res.status(400).json({ error: 'Rango de horario inválido.' });
    }

    const bloqueos = leerBloqueos();
    const grupoId = Date.now().toString();
    horarios.forEach(horario => {
      bloqueos.push({ id: `${grupoId}-${horario}`, grupoId, dia, barbero, horario });
    });
    guardarBloqueos(bloqueos);

    res.json({ ok: true, grupoId });
  } catch (e) {
    console.error('Error creando bloqueo:', e);
    res.status(500).json({ error: 'No se pudo crear el bloqueo.' });
  }
});

app.delete('/api/bloqueos/:grupoId', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    const bloqueos = leerBloqueos();
    const nuevos = bloqueos.filter(b => b.grupoId !== req.params.grupoId);
    if (nuevos.length === bloqueos.length) {
      return res.status(404).json({ error: 'Bloqueo no encontrado.' });
    }
    guardarBloqueos(nuevos);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error borrando bloqueo:', e);
    res.status(500).json({ error: 'No se pudo borrar el bloqueo.' });
  }
});

app.patch('/api/turnos/:id/completar', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    const turnos = leerTurnos();
    const turno = turnos.find(t => t.id === req.params.id);
    if (!turno) {
      return res.status(404).json({ error: 'Turno no encontrado.' });
    }
    const completado = req.body && typeof req.body.completado === 'boolean' ? req.body.completado : true;
    const pasaACompletado = completado && !turno.completado; // transición false -> true
    turno.completado = completado;

    if (pasaACompletado && FIDELIDAD_TARJETA_ACTIVA) {
      const numeroNormalizado = limpiarNumero(turno.whatsapp);
      const totalConEste = cortesEfectivosDeTurnos(turnos, numeroNormalizado);
      const hito = calcularHitoDeCorte(totalConEste);
      if (hito) {
        turno.hitoFidelidad = hito;
        turno.hitoFidelidadAvisado = false;
      }
    }

    guardarTodosLosTurnos(turnos);
    res.json({ ok: true, turno });
  } catch (e) {
    console.error('Error confirmando turno:', e);
    res.status(500).json({ error: 'No se pudo actualizar el turno.' });
  }
});

app.delete('/api/turnos/:id', (req, res) => {
  if (req.query.key !== PANEL_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    const turnos = leerTurnos();
    const nuevos = turnos.filter(t => t.id !== req.params.id);
    if (nuevos.length === turnos.length) {
      return res.status(404).json({ error: 'Turno no encontrado.' });
    }
    guardarTodosLosTurnos(nuevos);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error borrando turno:', e);
    res.status(500).json({ error: 'No se pudo borrar el turno.' });
  }
});

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'cambiar-este-token';

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado por Meta.');
    return res.status(200).send(challenge);
  }
  console.log('❌ Verificación de webhook fallida (token no coincide).');
  res.sendStatus(403);
});

function verificarFirmaMeta(req) {
  const appSecret = process.env.META_APP_SECRET;
  const firma = req.get('x-hub-signature-256') || '';
  if (!appSecret || !req.rawBody || !/^sha256=[a-f0-9]{64}$/i.test(firma)) return false;
  const esperada = crypto.createHmac('sha256', appSecret).update(req.rawBody).digest();
  const recibida = Buffer.from(firma.slice(7), 'hex');
  return recibida.length === esperada.length && crypto.timingSafeEqual(esperada, recibida);
}

app.post('/webhook', async (req, res) => {
  // Sin App Secret configurado o con firma inválida, no confiar en el evento:
  // podría ser una petición falsificada para abrir ventanas de 24 horas.
  if (!verificarFirmaMeta(req)) {
    console.error('⛔ Webhook rechazado: falta META_APP_SECRET o la firma de Meta no es válida.');
    return res.sendStatus(process.env.META_APP_SECRET ? 401 : 503);
  }

  res.sendStatus(200);

  try {
    // Meta puede agrupar varias entradas/cambios en una notificación.
    // Procesamos todos los estados y mensajes, no solo el primero.
    const cambios = (req.body?.entry || []).flatMap(e => e.changes || []);
    for (const c of cambios) {
      if (CAMPOS_ALERTA_META.includes(c.field)) {
        await procesarAlertaMeta(c.field, c.value);
        continue;
      }

      const value = c.value;
      for (const s of value?.statuses || []) {
        const detalleError = s.errors?.[0]?.title || s.errors?.[0]?.message || null;
        console.log(`📬 Estado de mensaje ${s.id}: ${s.status}${detalleError ? ' - ' + detalleError : ''}`);
        actualizarEstadoRealMensaje(s.id, s.status, detalleError);
      }

      for (const mensaje of value?.messages || []) {
        if (!mensaje) continue;
        const numeroCliente = mensaje.from;
        const texto = mensaje.text?.body || '';

        const yaProcesado = mensajeEntranteYaProcesado(mensaje.id);
        if (yaProcesado === true) {
          console.log(`↩️ Evento entrante duplicado ignorado: ${mensaje.id}`);
          continue;
        }

        if (esPedidoDeBaja(texto)) {
          // La BAJA se persiste antes de marcar el ID: ante un fallo de disco
          // o reinicio, priorizamos no volver a escribirle a quien pidió parar.
          guardarBaja(numeroCliente, true);
          if (yaProcesado === false) registrarMensajeEntranteUnico(mensaje.id);
        } else if (esPedidoDeAlta(texto)) {
          // La ALTA se marca primero: un reintento viejo no debe borrar una
          // BAJA más reciente si el registro de duplicados está fallando.
          if (yaProcesado !== false || registrarMensajeEntranteUnico(mensaje.id) !== true) continue;
          guardarBaja(numeroCliente, false);
        } else {
          // Ante un fallo del registro, no enviar respuestas normales.
          if (yaProcesado !== false || registrarMensajeEntranteUnico(mensaje.id) !== true) continue;
        }

        // El cliente nos escribió: se abre la ventana de 24hs en la que Meta
        // permite responder sin plantilla.
        registrarEntrante(numeroCliente);

        await marcarComoLeido(mensaje.id);
        console.log(`📩 Mensaje recibido de ${numeroCliente}: "${texto}"`);

        if (esPedidoDeBaja(texto)) {
          guardarBaja(numeroCliente, true);
          await enviarYRegistrar(numeroCliente,
            `✅ Listo, no te vamos a mandar más recordatorios por WhatsApp. Si tenés un turno reservado, sigue en pie.\n\n` +
            `Si querés volver a recibirlos, respondé ALTA. Cualquier duda: ${TELEFONO_CONTACTO_HUMANO}.`, 'webhook');
          continue;
        }
        if (esPedidoDeAlta(texto)) {
          guardarBaja(numeroCliente, false);
          await enviarYRegistrar(numeroCliente, `👍 Perfecto, volvés a recibir los recordatorios de tus turnos.`, 'webhook');
          continue;
        }

        // La baja también bloquea confirmaciones y avisos automáticos pendientes.
        // Solo se reactiva cuando el propio cliente responde ALTA.
        if (estaDadoDeBaja(numeroCliente)) {
          console.log(`⏸️ Mensaje automático omitido para ${numeroCliente}: pidió la baja.`);
          continue;
        }

        const turno = buscarTurnoPorNumero(numeroCliente);
        let respuesta = null;
        let turnoConfirmacionPendienteId = null;
        let hitoPendienteId = null;

        if (turno && !turno.confirmacionEnviada) {
          turnoConfirmacionPendienteId = turno.id;
          respuesta = construirMensajeConfirmacion(turno);
          const avisoAnticipado = textoAvisoAnticipado(numeroCliente, turno.consentimientoFidelidadWhatsapp?.aceptado === true);
          if (avisoAnticipado) respuesta = `${respuesta}\n\n${avisoAnticipado}`;
        }

        if (FIDELIDAD_TARJETA_ACTIVA) {
          const turnoConHito = buscarHitoPendiente(numeroCliente);
          if (turnoConHito) {
            const yaDicho = ['50', 'gratis'].includes(turnoConHito.hitoFidelidad) && /Este turno/.test(respuesta || '');
            if (!yaDicho) {
              const nota = textoHitoFidelidad(turnoConHito.hitoFidelidad);
              respuesta = respuesta ? `${respuesta}\n\n${nota}` : nota;
            }
            hitoPendienteId = turnoConHito.id;
          }
        }

        if (respuesta) {
          const resultadoEnvio = await enviarYRegistrar(numeroCliente, respuesta, 'webhook');
          if (resultadoEnvio.enviado) {
            if (turnoConfirmacionPendienteId) {
              const turnosActuales = leerTurnos();
              const turnoActual = turnosActuales.find(t => t.id === turnoConfirmacionPendienteId);
              if (turnoActual && !turnoActual.confirmacionEnviada) {
                turnoActual.confirmacionEnviada = true;
                guardarTodosLosTurnos(turnosActuales);
              }
            }
            if (hitoPendienteId) marcarHitoAvisado(hitoPendienteId);
          }
        }
      }
    }
  } catch (e) {
    console.error('❌ Error procesando webhook:', e);
  }
});

app.get('/', (req, res) => res.send('AMB Barbers bot API OK'));

const omitidosLogueados = new Set();

// Recordatorios. Solo salen si: (1) están activados, (2) el cliente nos escribió en las
// últimas 24hs, (3) no pidió la baja y (4) no se agotaron los intentos. Antes, si el envío
// fallaba se reintentaba CADA MINUTO durante media hora: decenas de intentos rechazados
// por turno, que Meta puede ver como mensajería no autorizada.
cron.schedule('* * * * *', async () => {
 try {
  if (!RECORDATORIOS_ACTIVOS) return;
  const ahora = new Date();
  const turnos = leerTurnos();
  const cambiosPorId = new Map();

  for (const turno of turnos) {
    if (turno.recordatorioEnviado) continue;
    // No enviar recordatorios de turnos antiguos o importados sin constancia
    // explícita del consentimiento de WhatsApp.
    if (turno.consentimientoWhatsapp?.aceptado !== true) continue;
    if ((turno.recordatorioIntentos || 0) >= MAX_INTENTOS_RECORDATORIO) continue;
    if (!correspondeRecordatorio(turno)) continue; // se reservó con más de 24hs de anticipación

    const horaTurno = fechaHoraDelTurno(turno);
    const minutosFaltantes = (horaTurno - ahora) / 60000;
    const minutosDeAviso = minutosDeAvisoPara(turno);

    if (minutosFaltantes <= minutosDeAviso && minutosFaltantes > 0) {
      if (estaDadoDeBaja(turno.whatsapp)) continue; // pidió no recibir mensajes

      // Solo a quien nos escribió en las últimas 24hs: fuera de esa ventana WhatsApp solo
      // permite iniciar conversaciones con plantillas aprobadas.
      if (!ventanaAbierta(turno.whatsapp)) {
        if (!omitidosLogueados.has(turno.id)) {
          omitidosLogueados.add(turno.id);
          console.log(`⏸️ Recordatorio omitido para ${turno.nombre}: no nos escribió en las últimas 24hs.`);
        }
        continue;
      }

      console.log(`⏰ Intentando recordatorio a ${turno.nombre} (${turno.whatsapp})`);
      const cambios = { recordatorioIntentos: (turno.recordatorioIntentos || 0) + 1 };
      cambiosPorId.set(turno.id, cambios);
      try {
        const resultado = await enviarYRegistrar(
          turno.whatsapp,
          `⏰ ¡Hola ${turno.nombre}! Te recordamos tu turno el ${formatearFecha(turno.dia)} a las ${turno.horario} hs ` +
          `con ${turno.barbero} (${turno.servicio}). ¡Te esperamos en AMB Barbers!\n\n` +
          `Si necesitás cambiarlo o hablar con una persona, escribinos o llamanos al ${TELEFONO_CONTACTO_HUMANO}. ` +
          `Si no querés recibir más recordatorios, respondé BAJA.`,
          'recordatorio'
        );
        if (resultado.enviado) {
          cambios.recordatorioEnviado = true;
          console.log(`✅ Recordatorio enviado a ${turno.nombre} (${turno.whatsapp})`);
        } else {
          console.log(`⏸️ Recordatorio no enviado a ${turno.nombre} (intento ${cambios.recordatorioIntentos}/${MAX_INTENTOS_RECORDATORIO}).`);
        }
      } catch (e) {
        console.error('Error enviando recordatorio:', e);
      }
    }
  }

  if (cambiosPorId.size) {
    // Se relee el archivo antes de guardar para no pisar reservas que entraron mientras tanto.
    const actuales = leerTurnos();
    actuales.forEach(t => { const c = cambiosPorId.get(t.id); if (c) Object.assign(t, c); });
    guardarTodosLosTurnos(actuales);
  }
 } catch (e) {
   console.error('Error general en el cron de recordatorios:', e);
 }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
