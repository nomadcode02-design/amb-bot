require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { startBot, sendMessage } = require('./bot');
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

function formatearFecha(diaISO) {
  const [y, m, d] = diaISO.split('-');
  return `${d}/${m}/${y}`;
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

app.get('/', (req, res) => res.send('AMB Barbers bot API OK'));

const PORT = process.env.PORT || 3000;

startBot().then(() => {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
