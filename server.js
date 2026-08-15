require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { sendMessage, armarLinkWhatsApp, limpiarNumero } = require('./whatsapp-cloud');
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
app.use(cors());
app.use(express.json());

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
const MAX_MENSAJES_GUARDADOS = 500; // para que el archivo no crezca sin límite

function leerMensajes() {
  return JSON.parse(fs.readFileSync(MENSAJES_FILE, 'utf-8'));
}
function guardarMensajes(mensajes) {
  const recortados = mensajes.slice(-MAX_MENSAJES_GUARDADOS);
  fs.writeFileSync(MENSAJES_FILE, JSON.stringify(recortados, null, 2));
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
  let h = Number(horaInicio.split(':')[0]);
  const hFin = Number(horaFin.split(':')[0]);
  while (h < hFin) {
    horarios.push(`${String(h).padStart(2, '0')}:00`);
    h++;
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
    `¡Nos vemos pronto!`
  );
}

// Compara el número que llega de Meta (mensaje.from) contra los guardados
// en los turnos, pasando LOS DOS por limpiarNumero antes de comparar. Sin
// esto, un contacto nuevo (primera vez que le escribe al bot) puede llegar
// en un formato levemente distinto (ej: sin el "9") al que ya está
// normalizado en turnos.json, y el matcheo fallaba en el primer mensaje —
// para recién funcionar en el segundo, cuando Meta ya "conoce" el contacto
// y lo manda completo.
function buscarTurnoPorNumero(numeroCliente) {
  const numeroClienteNormalizado = limpiarNumero(numeroCliente);
  const turnos = leerTurnos().sort((a, b) => new Date(b.creado) - new Date(a.creado));
  return turnos.find(t => limpiarNumero(t.whatsapp) === numeroClienteNormalizado) || null;
}

app.post('/api/reservar', async (req, res) => {
  try {
    const { nombre, whatsapp, barbero, servicio, dia, horario } = req.body;

    if (!nombre || !whatsapp || !barbero || !servicio || !dia || !horario) {
      return res.status(400).json({ error: 'Faltan datos de la reserva.' });
    }

    const servicioInfo = SERVICIOS[servicio];
    const barberoNombre = BARBEROS[barbero];
    if (!servicioInfo || !barberoNombre) {
      return res.status(400).json({ error: 'Servicio o barbero inválido.' });
    }

    const resultadoReserva = await conLockDeTurnos(() => {
      const turnosExistentes = leerTurnos();
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
      };
      guardarTurno(turno);
      return { turno };
    });

    if (resultadoReserva.error) {
      return res.status(409).json({ error: resultadoReserva.error });
    }
    const turno = resultadoReserva.turno;

    const fechaLinda = formatearFecha(dia);
    const mensajeCliente = construirMensajeConfirmacion(turno);

    // El cliente va a escribirle al bot desde el link de WhatsApp del
    // formulario, y ahí es donde se manda la confirmación también (ver el
    // webhook más abajo). Acá probamos mandarla ya mismo, por si la
    // ventana de 24hs ya estaba abierta con ese número.
    let whatsappLink = armarLinkWhatsApp(whatsapp, `Hola! Quiero confirmar mi turno para ${fechaLinda} a las ${horario} hs 💈`);
    let mensajeEnviado = false;
    try {
      const resultado = await enviarYRegistrar(whatsapp, mensajeCliente, 'confirmacion');
      mensajeEnviado = resultado.enviado;
      if (mensajeEnviado) {
        turno.confirmacionEnviada = true;
        guardarTodosLosTurnos(leerTurnos().map(t => t.id === turno.id ? turno : t));
      }
    } catch (e) {
      console.error('⚠️ No se pudo enviar confirmación al cliente todavía (esperará a que escriba):', e.message);
    }

    if (OWNER_WHATSAPP) {
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
    turno.completado = completado;
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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // Meta manda dos tipos de eventos distintos por este mismo webhook:
    // "messages" (alguien nos escribió) y "statuses" (avisos de qué pasó
    // con un mensaje que NOSOTROS mandamos: sent/delivered/read/failed).
    // Sin procesar "statuses", solo sabíamos que la API había aceptado el
    // envío — no si realmente llegó al celular del cliente.
    const statuses = value?.statuses;
    if (statuses && statuses.length > 0) {
      for (const s of statuses) {
        const detalleError = s.errors?.[0]?.title || s.errors?.[0]?.message || null;
        console.log(`📬 Estado de mensaje ${s.id}: ${s.status}${detalleError ? ' - ' + detalleError : ''}`);
        actualizarEstadoRealMensaje(s.id, s.status, detalleError);
      }
    }

    const mensaje = value?.messages?.[0];
    if (!mensaje) return;

    const numeroCliente = mensaje.from;
    const texto = mensaje.text?.body || '';
    console.log(`📩 Mensaje recibido de ${numeroCliente}: "${texto}"`);

    const turno = buscarTurnoPorNumero(numeroCliente);
    let respuesta;

    if (turno) {
      turno.confirmacionEnviada = true;
      guardarTodosLosTurnos(leerTurnos().map(t => (t.id === turno.id ? turno : t)));
      respuesta = construirMensajeConfirmacion(turno);
    } else {
      respuesta =
        `¡Hola! 👋 Gracias por comunicarte con AMB BARBERS.\n` +
        `En este momento no estamos respondiendo. Lo haremos lo antes posible!\n\n` +
        `Podés reservar tu turno igual desde nuestra página y te confirmamos el lugar 😉\n\n` +
        `Link: https://nomadcode02-design.github.io/amb-barber/\n\n` +
        `Nos vemos!`;
    }

    await enviarYRegistrar(numeroCliente, respuesta, 'webhook');
  } catch (e) {
    console.error('❌ Error procesando webhook:', e);
  }
});

app.get('/', (req, res) => res.send('AMB Barbers bot API OK'));

cron.schedule('* * * * *', async () => {
 try {
  const ahora = new Date();
  const turnos = leerTurnos();
  let huboCambios = false;

  for (const turno of turnos) {
    if (turno.recordatorioEnviado) continue;
    if (!correspondeRecordatorio(turno)) continue; // se reservó con más de 24hs de anticipación

    const horaTurno = fechaHoraDelTurno(turno);
    const minutosFaltantes = (horaTurno - ahora) / 60000;
    const minutosDeAviso = minutosDeAvisoPara(turno);

    if (minutosFaltantes <= minutosDeAviso && minutosFaltantes > 0) {
      console.log(`⏰ Intentando recordatorio a ${turno.nombre} (${turno.whatsapp})`);
      try {
        const resultado = await enviarYRegistrar(
          turno.whatsapp,
          `⏰ ¡Hola ${turno.nombre}! Te recordamos tu turno el ${formatearFecha(turno.dia)} a las ${turno.horario} hs ` +
          `con ${turno.barbero} (${turno.servicio}). ¡Te esperamos en AMB Barbers!`,
          'recordatorio'
        );
        if (resultado.enviado) {
          turno.recordatorioEnviado = true;
          huboCambios = true;
          console.log(`✅ Recordatorio enviado a ${turno.nombre} (${turno.whatsapp})`);
        } else {
          console.log(`⏸️ Recordatorio no enviado a ${turno.nombre}: ventana de 24hs cerrada.`);
        }
      } catch (e) {
        console.error('Error enviando recordatorio:', e);
      }
    }
  }

  if (huboCambios) guardarTodosLosTurnos(turnos);
 } catch (e) {
   console.error('Error general en el cron de recordatorios:', e);
 }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
