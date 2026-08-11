require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const cron = require('node-cron');
const { startBot, sendMessage, armarLinkWhatsApp, resolverJid, setOnMensaje, getLatestQR, isConnected } = require('./bot');
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

// Misma carpeta persistente que usa bot.js para auth_info y contactos.json.
// En Railway: Volume montado en /data + variable de entorno DATA_DIR=/data.
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

// Busca, entre los turnos SIN confirmar todavía, cuál corresponde al
// número que acaba de escribirle al bot. Resuelve el JID de cada turno
// candidato y lo compara contra el JID entrante (en cualquiera de sus
// dos formas: @lid o @s.whatsapp.net).
async function buscarTurnoPorJid(remoteJid, remoteJidAlt) {
  const turnos = leerTurnos();
  const candidatos = turnos
    .filter(t => !t.confirmacionEnviada)
    .sort((a, b) => new Date(b.creado) - new Date(a.creado)); // más recientes primero

  console.log(`🔍 Buscando turno para remoteJid=${remoteJid} remoteJidAlt=${remoteJidAlt}. Candidatos sin confirmar: ${candidatos.length}`);

  for (const turno of candidatos) {
    try {
      const jid = await resolverJid(turno.whatsapp);
      console.log(`   → turno de ${turno.nombre} (whatsapp guardado: "${turno.whatsapp}") resolvió a jid: ${jid}`);
      if (jid === remoteJid || jid === remoteJidAlt) return turno;
    } catch (e) {
      console.log(`   → turno de ${turno.nombre} (whatsapp guardado: "${turno.whatsapp}") NO se pudo resolver: ${e.message}`);
    }
  }
  return null;
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

    const turnosExistentes = leerTurnos();
    const yaOcupado = turnosExistentes.some(
      t => t.dia === dia && t.horario === horario && t.barbero === barberoNombre
    );
    if (yaOcupado) {
      return res.status(409).json({ error: `${barberoNombre} ya tiene un turno ocupado a esa hora. Elegí otro horario.` });
    }

    const bloqueos = leerBloqueos();
    const estaBloqueado = bloqueos.some(
      b => b.dia === dia && b.horario === horario && (b.barbero === 'Todos' || b.barbero === barbero)
    );
    if (estaBloqueado) {
      return res.status(409).json({ error: 'Ese horario no está disponible. Elegí otro.' });
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

    const fechaLinda = formatearFecha(dia);
    const mensajeCliente = construirMensajeConfirmacion(turno);

    // El cliente va a escribirle al bot desde el link de WhatsApp del
    // formulario, y ahí es donde se manda la confirmación (ver setOnMensaje
    // más abajo). Igual probamos mandarla ahora por si ya escribió antes
    // y la ventana de 24hs ya está abierta.
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

    // Enviar mensaje al dueño con protección de errores por si el número falla
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

// Recordatorios: solo se mandan si el cliente escribió al bot en las
// últimas 24hs (ventana abierta). Si no, se saltea silenciosamente:
// no queremos mandar mensajes proactivos a quien nunca inició contacto.
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

// Cuando alguien le escribe al bot (típicamente desde el link de WhatsApp
// del formulario de reservas), buscamos si tiene un turno pendiente de
// confirmar y le contestamos con los datos reales de SU turno.
setOnMensaje(async (remoteJid, textoRecibido, remoteJidAlt) => {
  const turno = await buscarTurnoPorJid(remoteJid, remoteJidAlt);

  if (turno) {
    turno.confirmacionEnviada = true;
    guardarTodosLosTurnos(leerTurnos().map(t => t.id === turno.id ? turno : t));
    return construirMensajeConfirmacion(turno);
  }

  // No encontramos ningún turno pendiente para este número.
  return (
    `¡Hola! Gracias por escribirnos a AMB Barbers 💈\n\n` +
    `No encontramos ningún turno pendiente asociado a este número. ` +
    `Si querés reservar, hacelo desde nuestra web y después escribinos por acá para confirmar.\n\n` +
    `👉 https://nomadcode02-design.github.io/amb-barber/formulario.html`
  );
});

const PORT = process.env.PORT || 3000;

startBot().then(() => {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
