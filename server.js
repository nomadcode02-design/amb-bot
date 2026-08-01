require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const cron = require('node-cron');
const { startBot, sendMessage, getLatestQR, isConnected } = require('./bot');
const { SERVICIOS, BARBEROS, HORARIOS_POR_DIA } = require('./data');

// ---------- Red de seguridad: errores no capturados ----------
// Sin esto, un solo error inesperado en cualquier parte del código (una
// promesa rechazada sin manejar, por ejemplo) tira abajo TODO el proceso:
// se cae el bot de WhatsApp, el endpoint de reservas, los recordatorios,
// todo junto. Con esto, el error queda logueado pero el servidor sigue
// funcionando para todo lo demás.
process.on('uncaughtException', (err) => {
  console.error('⚠️ Error no capturado (el servidor sigue funcionando):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Promesa rechazada sin manejar (el servidor sigue funcionando):', reason);
});

const app = express();
app.use(cors());
app.use(express.json());

const TURNOS_FILE = path.join(__dirname, 'turnos.json');
if (!fs.existsSync(TURNOS_FILE)) fs.writeFileSync(TURNOS_FILE, '[]');

const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');
if (!fs.existsSync(BLOQUEOS_FILE)) fs.writeFileSync(BLOQUEOS_FILE, '[]');

const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP; // ej: 2646023107
const PANEL_KEY = process.env.PANEL_KEY || 'cambiar-esta-clave'; // clave del panel de control

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

function leerBloqueos() {
  return JSON.parse(fs.readFileSync(BLOQUEOS_FILE, 'utf-8'));
}
function guardarTodosLosBloqueos(bloqueos) {
  fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify(bloqueos, null, 2));
}

// Genera la lista de horarios en punta (formato "HH:00") entre horaInicio
// (inclusive) y horaFin (exclusive), en pasos de 1 hora. Ej: "14:00" a "17:00"
// devuelve ["14:00","15:00","16:00"].
function generarRangoHorarios(horaInicio, horaFin) {
  const [hIni, mIni] = horaInicio.split(':').map(Number);
  const [hFin, mFin] = horaFin.split(':').map(Number);
  let t = hIni * 60 + mIni;
  const fin = hFin * 60 + mFin;
  const horarios = [];
  while (t < fin) {
    const hh = String(Math.floor(t / 60)).padStart(2, '0');
    const mm = String(t % 60).padStart(2, '0');
    horarios.push(`${hh}:${mm}`);
    t += 60;
  }
  return horarios;
}

// Un turno o una consulta "aplica" a un bloqueo si el bloqueo es para "Todos"
// los barberos, o si es específicamente para ese barbero.
function bloqueoAplicaABarbero(bloqueo, barberoNombreOClave) {
  return bloqueo.barbero === 'Todos' || bloqueo.barbero === barberoNombreOClave;
}

// Chequea si un horario ("HH:MM") cae dentro de alguna franja de atención
// del día de la semana que corresponda a "dia" (formato "YYYY-MM-DD").
// Soporta días con turno partido (varias franjas), como lunes a jueves.
function horarioDentroDeAtencion(dia, horario) {
  const fecha = new Date(`${dia}T00:00:00`);
  const dow = fecha.getDay();
  const franjas = HORARIOS_POR_DIA[dow] || [];

  const [h, m] = horario.split(':').map(Number);
  const minutosPedidos = h * 60 + m;

  return franjas.some(({ apertura, cierre }) => {
    const [hIni, mIni] = apertura.split(':').map(Number);
    const [hFin, mFin] = cierre.split(':').map(Number);
    const minIni = hIni * 60 + mIni;
    const minFin = hFin * 60 + mFin;
    return minutosPedidos >= minIni && minutosPedidos < minFin;
  });
}

function formatearFecha(diaISO) {
  const [y, m, d] = diaISO.split('-');
  return `${d}/${m}/${y}`;
}

// Combina "dia" (YYYY-MM-DD) + "horario" (HH:MM) en un objeto Date real.
// Importante: se fuerza el offset -03:00 (hora de Argentina) para que el
// cálculo sea correcto sin importar en qué zona horaria corra el servidor
// de Railway (por defecto suele correr en UTC).
function fechaHoraDelTurno(turno) {
  return new Date(`${turno.dia}T${turno.horario}:00-03:00`);
}

// Decide con cuántos minutos de anticipación mandar el recordatorio,
// según cuánto tiempo hubo entre el momento de la reserva y la hora del turno.
// Si reservaron con mucha antelación, avisa 30 min antes; si reservaron
// más sobre la hora, avisa más cerca (10 o 5 min antes) para no perder el aviso.
function minutosDeAvisoPara(turno) {
  const horaTurno = fechaHoraDelTurno(turno);
  const anticipacionTotal = (horaTurno - new Date(turno.creado)) / 60000;
  if (anticipacionTotal > 60) return 30;
  if (anticipacionTotal > 20) return 20;
  return 5;
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

    // Chequear que el horario pedido esté dentro de la franja de atención de ese día
    // (soporta turno partido, ej: lunes a jueves cerrado de 13 a 17hs)
    if (!horarioDentroDeAtencion(dia, horario)) {
      return res.status(400).json({ error: 'Ese horario está fuera del horario de atención.' });
    }

    // Chequear que ese barbero no tenga ya un turno ocupado ese día y horario
    const turnosExistentes = leerTurnos();
    const yaOcupado = turnosExistentes.some(
      t => t.dia === dia && t.horario === horario && t.barbero === barberoNombre
    );
    if (yaOcupado) {
      return res.status(409).json({ error: `${barberoNombre} ya tiene un turno ocupado a esa hora. Elegí otro horario.` });
    }

    // Chequear que ese horario no esté bloqueado manualmente desde el panel
    // (ej: salida del barbero, feriado puntual, etc.)
    const bloqueos = leerBloqueos();
    const estaBloqueado = bloqueos.some(
      b => b.dia === dia && b.horario === horario && bloqueoAplicaABarbero(b, barberoNombre)
    );
    if (estaBloqueado) {
      return res.status(409).json({ error: 'Ese horario no está disponible. Elegí otro horario.' });
    }

    const turno = {
      id: Date.now().toString(),
      nombre, whatsapp, barbero: barberoNombre,
      servicio: servicioInfo.nombre, precio: servicioInfo.precio,
      dia, horario,
      creado: new Date().toISOString(),
      recordatorioEnviado: false, // <-- nuevo campo para el recordatorio
    };
    guardarTurno(turno);

    const fechaLinda = formatearFecha(dia);
    const mensajeCliente =
      `✅ *Turno confirmado - AMB BARBERS*\n\n` +
      `Hola ${nombre}! Tu turno quedó agendado:\n\n` +
      `💈 Barbero: ${barberoNombre}\n` +
      `✂️ Servicio: ${servicioInfo.nombre}\n` +
      `📅 Día: ${fechaLinda}\n` +
      `🕐 Hora: ${horario} hs\n` +
      `💰 Precio: ${servicioInfo.precio}\n\n` +
      `📍 Calle 9 de Julio, entre Mitre y Av. Ramón Barrera, Santa Rosa - 25 de Mayo, San Juan.\n\n` +
      `Te esperamos. Si necesitás cambiar el turno, respondé este mensaje.`;

    await sendMessage(whatsapp, mensajeCliente);

    if (OWNER_WHATSAPP) {
      const mensajeDueno =
        `📌 Nueva reserva confirmada automáticamente:\n` +
        `${nombre} (${whatsapp})\n${barberoNombre} - ${servicioInfo.nombre}\n${fechaLinda} ${horario} hs`;
      await sendMessage(OWNER_WHATSAPP, mensajeDueno);
    }

    res.json({ ok: true, turno });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno al procesar la reserva.' });
  }
});

// Endpoint público (sin clave): solo devuelve qué horarios están ocupados
// para un barbero y día puntual, sin exponer nombres ni teléfonos de clientes.
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
    const ocupadosPorTurnos = turnos
      .filter(t => t.dia === dia && t.barbero === barberoNombre)
      .map(t => t.horario);

    const bloqueos = leerBloqueos();
    const ocupadosPorBloqueo = bloqueos
      .filter(b => b.dia === dia && bloqueoAplicaABarbero(b, barberoNombre))
      .map(b => b.horario);

    // Set para no repetir horarios si coinciden turno y bloqueo
    const ocupados = [...new Set([...ocupadosPorTurnos, ...ocupadosPorBloqueo])];
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

// ---------- Bloqueo manual de horarios (desde el panel) ----------
// Sirve para casos como "los chicos salen de 14 a 15hs": ese rango queda
// sin poder reservarse (el formulario lo tacha) y no genera turnos ni
// mensajes del bot, porque no es un turno real, es solo un bloqueo.

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

    const barberoGuardado = barbero === 'Todos' ? 'Todos' : BARBEROS[barbero];
    if (!barberoGuardado) {
      return res.status(400).json({ error: 'Barbero inválido.' });
    }

    const horarios = generarRangoHorarios(horaInicio, horaFin);
    if (horarios.length === 0) {
      return res.status(400).json({ error: 'El rango de horario no es válido (verificá que "Hasta" sea posterior a "Desde").' });
    }

    const grupoId = Date.now().toString();
    const nuevosBloqueos = horarios.map(horario => ({ grupoId, dia, barbero: barberoGuardado, horario }));

    const bloqueos = leerBloqueos();
    guardarTodosLosBloqueos(bloqueos.concat(nuevosBloqueos));

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
    guardarTodosLosBloqueos(nuevos);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error borrando bloqueo:', e);
    res.status(500).json({ error: 'No se pudo borrar el bloqueo.' });
  }
});

app.get('/qr', async (req, res) => {
  if (isConnected()) {
    return res.send(`
      <body style="background:#0d0d0c;color:#8fbf7a;font-family:sans-serif;text-align:center;padding:60px">
        <h1>✅ El bot ya está conectado a WhatsApp</h1>
        <p>No hace falta escanear nada.</p>
      </body>
    `);
  }

  const qr = getLatestQR();
  if (!qr) {
    return res.send(`
      <body style="background:#0d0d0c;color:#f2ede2;font-family:sans-serif;text-align:center;padding:60px">
        <h1>Generando QR...</h1>
        <p>Refrescá en unos segundos.</p>
        <script>setTimeout(()=>location.reload(), 3000)</script>
      </body>
    `);
  }

  const qrImage = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
  res.send(`
    <body style="background:#0d0d0c;color:#f2ede2;font-family:sans-serif;text-align:center;padding:40px">
      <h1>Escaneá este QR con el WhatsApp de AMB Barbers</h1>
      <p>Configuración → Dispositivos vinculados → Vincular un dispositivo</p>
      <img src="${qrImage}" style="background:#fff;padding:16px;border-radius:8px;margin-top:20px">
      <p style="color:#a39c8f">Esta página se refresca sola cada 15 segundos hasta que te conectes.</p>
      <script>setTimeout(()=>location.reload(), 15000)</script>
    </body>
  `);
});

app.get('/', (req, res) => res.send('AMB Barbers bot API OK'));

// ---------- Recordatorio automático 30 minutos antes del turno ----------
// Corre cada minuto y revisa si algún turno está por empezar en media hora.
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

    // Si faltan `minutosDeAviso` minutos o menos (y el turno todavía no pasó)
    // y todavía no se mandó el aviso, se manda ahora. Esto cubre tanto el
    // caso normal (se detecta al cruzar el umbral) como el de una reserva
    // hecha sobre la hora (el umbral ya es más chico en ese caso).
    if (minutosFaltantes <= minutosDeAviso && minutosFaltantes > 0) {
      try {
        await sendMessage(
          turno.whatsapp,
          `⏰ ¡Hola ${turno.nombre}! Te recordamos que tenés un turno hoy a las ${turno.horario} hs ` +
          `con ${turno.barbero} (${turno.servicio}). ¡Te esperamos en AMB Barbers!`
        );
        turno.recordatorioEnviado = true;
        huboCambios = true;
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

startBot().then(() => {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
