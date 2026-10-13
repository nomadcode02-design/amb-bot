// TODO: la duración es un estimado (45 min) hasta que definas cuánto dura cada uno.
const SERVICIOS = [
  { id: "corte-lavado", nombre: "Corte moderno", detalle: "Incluye lavado", precio: "$12.000", duracion: 45 },
  { id: "corte-mascarilla", nombre: "Corte moderno + Mascarilla facial", detalle: "Puntos negros", precio: "$15.000", duracion: 45 },
  { id: "corte-nutricion", nombre: "Corte moderno + Nutrición capilar", detalle: "", precio: "$20.000", duracion: 45 },
  { id: "corte-completo", nombre: "Corte moderno + Mascarilla facial + Nutrición capilar", detalle: "", precio: "$25.000", duracion: 60 },
];

const BARBEROS = [
  { id: "sebastian", nombre: "Sebastian" },
  { id: "ale", nombre: "Ale" },
];

// Horario de atención: 09:00 a 21:00 corrido, todos los días excepto domingo
// (mismo horario que antes tenían viernes y sábado, ahora de lunes a sábado).
//
// Cada día de la semana (0=domingo ... 6=sábado) tiene una lista de franjas.
// Un día cerrado es una lista vacía [].
const HORARIOS_POR_DIA = {
  0: [], // domingo - cerrado
  1: [{ apertura: "09:00", cierre: "21:00" }], // lunes
  2: [{ apertura: "09:00", cierre: "21:00" }], // martes
  3: [{ apertura: "09:00", cierre: "21:00" }], // miércoles
  4: [{ apertura: "09:00", cierre: "21:00" }], // jueves
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
  module.exports = { SERVICIOS, BARBEROS, HORARIOS_POR_DIA, API_URL };
}
