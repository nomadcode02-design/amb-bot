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

// ---------- Cola de escritura para reservas ----------
// Si dos personas reservan casi al mismo tiempo, sin esto ambas peticiones
// podrían leer turnos.json "viejo" a la vez, chequear que el horario está
// libre, y las dos terminar guardando: una se pisa a la otra, o las dos
// quedan agendadas en el mismo horario con el mismo barbero. Encolando el
// chequeo + guardado (uno a la vez, en orden) eso deja de ser posible: la
// segunda reserva siempre ve el turno que acaba de guardar la primera.
class ErrorReserva extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let colaReservas = Promise.resolve();
function encolarReserva(fn) {
  const resultado = colaReservas.then(fn, fn);
  colaReservas = resultado.then(() => {}, () => {}); // la cola sigue aunque una reserva falle
  return resultado;
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

// Varias versiones del recordatorio, elegidas al azar: mandar siempre el
// mismo string idéntico a distintos números es una señal de bot más fácil
// de detectar que variar un poco la redacción.
function textoRecordatorio(turno) {
  const variantes = [
    `⏰ ¡Hola ${turno.nombre}! Te recordamos que tenés un turno hoy a las ${turno.horario} hs con ${turno.barbero} (${turno.servicio}). ¡Te esperamos en AMB Barbers!`,
    `⏰ ${turno.nombre}, este es tu recordatorio: hoy a las ${turno.horario} hs tenés turno con ${turno.barbero} para ${turno.servicio}. ¡Te esperamos!`,
    `💈 Hola ${turno.nombre}! No te olvides de tu turno de hoy a las ${turno.horario} hs con ${turno.barbero} (${turno.servicio}). ¡Nos vemos pronto!`,
  ];
  return variantes[Math.floor(Math.random() * variantes.length)];
}

// Busca, entre los turnos SIN confirmar todavía, cuál corresponde al
// número que acaba de escribirle al bot. Resuelve el JID de cada turno
// candidato y lo compara contra el JID entrante (en cualquiera de sus
// dos formas: @lid o @s.whatsapp.net).
// Quedan afuera los turnos que ya pasaron de horario o que se marcaron
// como completados en el panel: si el cliente escribe después de eso,
// no tiene sentido mandarle de nuevo "tu turno quedó agendado" con una
// fecha vieja, así que directamente cae en el mensaje de "no encontramos
// turno pendiente, reservá de nuevo".
async function buscarTurnoPorJid(remoteJid, remoteJidAlt) {
  const ahora = new Date();
  const turnos = leerTurnos();
  const candidatos = turnos
    .filter(t => !t.confirmacionEnviada && !t.completado && fechaHoraDelTurno(t) > ahora)
    .sort((a, b) => new Date(b.creado) - new Date(a.creado)); // más recientes primero

  console.log(`🔍 Buscando turno para remoteJid=${remoteJid} remoteJidAlt=${remoteJidAlt}. Candidatos vigentes sin confirmar: ${candidatos.length}`);

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

// Un número es "confiable" si en algún turno anterior (de cualquier fecha)
// ya recibió una confirmación exitosa del bot. A esos clientes que vuelven
// a reservar no les pedimos que nos escriban primero para "abrir la
// ventana" — directo les mandamos la confirmación, forzando el envío. Es
// razonable: ya interactuaron con el bot antes, no son un desconocido al
// que le estamos escribiendo de la nada.
async function esNumeroConfiable(whatsapp) {
  try {
    const jidNuevo = await resolverJid(whatsapp);
    if (!jidNuevo) return false;
    const anteriores = leerTurnos().filter(t => t.confirmacionEnviada);
    for (const t of anteriores) {
      try {
        const jid = await resolverJid(t.whatsapp);
        if (jid === jidNuevo) return true;
      } catch {
        // no se pudo resolver ese turno viejo, seguimos con el próximo
      }
    }
    return false;
  } catch {
    return false;
  }
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

    // Chequeo de disponibilidad + guardado, encolado: así dos reservas que
    // llegan casi al mismo tiempo nunca se pisan ni terminan ocupando el
    // mismo horario (ver comentario de encolarReserva más arriba).
    const turno = await encolarReserva(() => {
      const turnosExistentes = leerTurnos();
      const yaOcupado = turnosExistentes.some(
        t => t.dia === dia && t.horario === horario && t.barbero === barberoNombre
      );
      if (yaOcupado) {
        throw new ErrorReserva(409, `${barberoNombre} ya tiene un turno ocupado a esa hora. Elegí otro horario.`);
      }

      const bloqueos = leerBloqueos();
      const estaBloqueado = bloqueos.some(
        b => b.dia === dia && b.horario === horario && (b.barbero === 'Todos' || b.barbero === barbero)
      );
      if (estaBloqueado) {
        throw new ErrorReserva(409, 'Ese horario no está disponible. Elegí otro.');
      }

      const nuevoTurno = {
        id: Date.now().toString(),
        nombre, whatsapp, barbero: barberoNombre,
        servicio: servicioInfo.nombre, precio: servicioInfo.precio,
        dia, horario,
        creado: new Date().toISOString(),
        recordatorioEnviado: false,
        completado: false,
      };
      guardarTurno(nuevoTurno);
      return nuevoTurno;
    });

    const fechaLinda = formatearFecha(dia);
    const mensajeCliente = construirMensajeConfirmacion(turno);

    // Si el número ya nos escribió alguna vez antes (cliente que vuelve),
    // le mandamos la confirmación directo, sin depender de la ventana de
    // 24hs. Si es la primera vez que reserva, sí necesita escribirle al
    // bot desde el link de WhatsApp del formulario para abrir la ventana
    // (ver setOnMensaje más abajo).
    const confiable = await esNumeroConfiable(whatsapp);
    let whatsappLink = armarLinkWhatsApp(whatsapp, `Hola! Quiero confirmar mi turno para ${fechaLinda} a las ${horario} hs 💈`);
    let mensajeEnviado = false;
    try {
      const resultado = await sendMessage(whatsapp, mensajeCliente, { forzar: confiable });
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

    res.json({ ok: true, turno, mensajeEnviado, whatsappLink, confiable });
  } catch (err) {
    if (err instanceof ErrorReserva) {
      return res.status(err.status).json({ error: err.message });
    }
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
        const resultado = await sendMessage(turno.whatsapp, textoRecordatorio(turno));
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

// Busca, entre los turnos de este número que YA recibieron confirmación,
// el más reciente que siga vigente (no pasó de horario y no está marcado
// como completado en el panel). Se usa cuando alguien escribe de nuevo y
// no tiene un turno pendiente por confirmar: en vez de no decirle nada, le
// repetimos los datos del turno confirmado que tiene. Si el único turno
// confirmado que tiene ya pasó o está completado, no cuenta — no tiene
// sentido repetirle datos de un turno viejo.
async function buscarUltimoTurnoConfirmadoPorJid(remoteJid, remoteJidAlt) {
  const ahora = new Date();
  const turnos = leerTurnos()
    .filter(t => t.confirmacionEnviada && !t.completado && fechaHoraDelTurno(t) > ahora)
    .sort((a, b) => new Date(b.creado) - new Date(a.creado)); // más reciente primero

  for (const turno of turnos) {
    try {
      const jid = await resolverJid(turno.whatsapp);
      if (jid === remoteJid || jid === remoteJidAlt) return turno;
    } catch (e) {
      // no se pudo resolver, seguimos con el próximo
    }
  }
  return null;
}

// Cuando alguien le escribe al bot (típicamente desde el link de WhatsApp
// del formulario de reservas), buscamos si tiene un turno pendiente de
// confirmar y le contestamos con los datos reales de SU turno. Si no tiene
// uno pendiente pero sí tiene un turno confirmado (de antes), se lo repetimos.
// Si no tiene ningún turno en absoluto, el bot no responde nada.
setOnMensaje(async (remoteJid, textoRecibido, remoteJidAlt) => {
  const turno = await buscarTurnoPorJid(remoteJid, remoteJidAlt);

  if (turno) {
    turno.confirmacionEnviada = true;
    guardarTodosLosTurnos(leerTurnos().map(t => t.id === turno.id ? turno : t));
    return construirMensajeConfirmacion(turno);
  }

  const turnoConfirmado = await buscarUltimoTurnoConfirmadoPorJid(remoteJid, remoteJidAlt);
  if (turnoConfirmado) {
    return construirMensajeConfirmacion(turnoConfirmado);
  }

  // No tiene ningún turno (ni pendiente ni confirmado): no respondemos nada.
  return null;
});

const PORT = process.env.PORT || 3000;

startBot().then(() => {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
