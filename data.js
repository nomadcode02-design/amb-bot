// TODO: la duración es un estimado (45 min) hasta que definas cuánto dura cada uno.
const SERVICIOS = [
  { id: "corte-lavado", nombre: "Corte moderno", detalle: "Incluye lavado", precio: "$12.000", duracion: 45 },
  { id: "corte-mascarilla", nombre: "Corte moderno + Mascarilla facial", detalle: "Puntos negros", precio: "$15.000", duracion: 45 },
  { id: "corte-nutricion", nombre: "Corte moderno + Nutrición capilar", detalle: "", precio: "$20.000", duracion: 45 },
  { id: "corte-completo", nombre: "Corte moderno + Mascarilla facial + Nutrición capilar", detalle: "", precio: "$25.000", duracion: 60 },
  // Servicios largos (4 hs): NO se reservan en la web. El barbero charla primero
  // con el cliente, así que el formulario lo manda a WhatsApp (consulta: true).
  { id: "permanente-ondulacion", nombre: "Permanente / Ondulación", detalle: "Se coordina por WhatsApp", precio: "$40.000", duracion: 240, consulta: true },
  { id: "claritos-mechas-corte", nombre: "Claritos / Mechas + Corte", detalle: "Se coordina por WhatsApp", precio: "$40.000", duracion: 240, consulta: true },
  { id: "global-color", nombre: "Global / Color", detalle: "Se coordina por WhatsApp", precio: "$60.000", duracion: 240, consulta: true },
];

// WhatsApp de la barbería (código de país + número, sin + ni espacios).
// A este número van los mensajes de los servicios que se coordinan por chat.
const WHATSAPP_BARBERIA = "5492643212176";

const BARBEROS = [
  { id: "sebastian", nombre: "Sebastian" },
  { id: "ale", nombre: "Ale" },
];

// Horario de atención:
// Lunes a Jueves: 09:00 a 13:00 y 17:00 a 21:00 (turno partido, mediodía cerrado)
// Viernes y Sábado: 09:00 a 21:00 corrido
// Domingo: cerrado
//
// Cada día de la semana (0=domingo ... 6=sábado) tiene una lista de franjas.
// Un día cerrado es una lista vacía []. Si algún día tiene una sola franja
// corrida (como viernes/sábado), va con un solo objeto en la lista.
const HORARIOS_POR_DIA = {
  0: [], // domingo - cerrado
  1: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // lunes
  2: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // martes
  3: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // miércoles
  4: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // jueves
  5: [{ apertura: "09:00", cierre: "21:00" }], // viernes
  6: [{ apertura: "09:00", cierre: "21:00" }], // sábado
};

// URL del backend del bot (se completa cuando esté desplegado)
const API_URL = "https://amb-bot-production.up.railway.app/api/reservar";

// Este archivo lo cargan DOS lugares distintos:
// 1) El formulario web, con <script src="data.js">, donde SERVICIOS y
//    BARBEROS tienen que quedar como variables globales (arrays) para que
//    el "forEach" del formulario funcione.
// 2) server.js, con require('./data'), donde hace falta un module.exports.
// El "if" de abajo solo se ejecuta en Node (en el navegador "module" no
// existe y esta parte se saltea sola, sin romper nada).
if (typeof module !== 'undefined' && module.exports) {
  // El servidor solo recibe los servicios que se reservan en la web: así nadie
  // puede crear un turno de los servicios que se coordinan por WhatsApp.
  module.exports = {
    SERVICIOS: SERVICIOS.filter(s => !s.consulta),
    BARBEROS, HORARIOS_POR_DIA, API_URL,
  };
}
