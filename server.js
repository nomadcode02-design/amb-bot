require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { sendMessage, armarLinkWhatsApp, limpiarNumero } = require('./whatsapp-cloud');
const { SERVICIOS, BARBEROS } = require('./data');

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

function minutosDeAvisoPara(turno) {
  const horaTurno = fechaHoraDelTurno(turno);
  const anticipacionTotal = (horaTurno - new Date(turno.creado)) / 60000;
  if (anticipacionTotal > 60) return 30;
  if (anticipacionTotal > 20) return 20;
  return 5;
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

function buscarTurnoPorNumero(numeroCliente) {
  const turnos = leerTurnos().sort((a, b) => new Date(b.creado) - new Date(a.creado));
  return turnos.find(t => limpiarNumero(t.whatsapp) === numeroCliente) || null;
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

    let whatsappLink = armarLinkWhatsApp(whatsapp, `Hola! Quiero confirmar mi turno para ${fechaLinda} a las ${horario} hs 💈`);
    let mensajeEnviado = false;
    try {
      const resultado = await sendMessage(whatsapp, mensajeCliente);
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
        await sendMessage(OWNER_WHATSAPP, mensajeDueno);
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

    await sendMessage(numeroCliente, respuesta);
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

    const horaTurno = fechaHoraDelTurno(turno);
    const minutosFaltantes = (horaTurno - ahora) / 60000;
    const minutosDeAviso = minutosDeAvisoPara(turno);

    if (minutosFaltantes <= minutosDeAviso && minutosFaltantes > 0) {
      console.log(`⏰ Intentando recordatorio a ${turno.nombre} (${turno.whatsapp})`);
      try {
        const resultado = await sendMessage(
          turno.whatsapp,
          `⏰ ¡Hola ${turno.nombre}! Te recordamos que tenés un turno hoy a las ${turno.horario} hs ` +
          `con ${turno.barbero} (${turno.servicio}). ¡Te esperamos en AMB Barbers!`
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
