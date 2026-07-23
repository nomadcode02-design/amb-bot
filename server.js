require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const cron = require('node-cron');
const { startBot, sendMessage, getLatestQR, isConnected } = require('./bot');
const { SERVICIOS, BARBEROS } = require('./data');

const app = express();
app.use(cors());
app.use(express.json());

const TURNOS_FILE = path.join(__dirname, 'turnos.json');
if (!fs.existsSync(TURNOS_FILE)) fs.writeFileSync(TURNOS_FILE, '[]');

const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP; // ej: 2646023107

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

app.get('/api/turnos', (req, res) => {
  res.json(leerTurnos());
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
  const ahora = new Date();
  const turnos = leerTurnos();
  let huboCambios = false;

  for (const turno of turnos) {
    if (turno.recordatorioEnviado) continue;

    const horaTurno = fechaHoraDelTurno(turno);
    const minutosFaltantes = (horaTurno - ahora) / 60000;

    // Ventana de 30 a 29 minutos antes (el cron corre una vez por minuto)
    if (minutosFaltantes <= 30 && minutosFaltantes > 29) {
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
});

const PORT = process.env.PORT || 3000;

startBot().then(() => {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
