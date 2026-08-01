// Mantené esto sincronizado con frontend/assets/js/data.js
const SERVICIOS = {
  "corte-lavado": { nombre: "Corte moderno (incluye lavado)", precio: "$12.000" },
  "corte-mascarilla": { nombre: "Corte moderno + Mascarilla facial (puntos negros)", precio: "$15.000" },
  "corte-nutricion": { nombre: "Corte moderno + Nutrición capilar", precio: "$20.000" },
  "corte-completo": { nombre: "Corte moderno + Mascarilla facial + Nutrición capilar", precio: "$25.000" },
};

const BARBEROS = {
  sebastian: "Sebastian",
  ale: "Ale",
};

// Horario de atención (debe coincidir con frontend/assets/js/data.js):
// Lunes a Jueves: 09:00 a 13:00 y 17:00 a 21:00 (turno partido)
// Viernes y Sábado: 09:00 a 21:00 corrido
// Domingo: cerrado
const HORARIOS_POR_DIA = {
  0: [], // domingo - cerrado
  1: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // lunes
  2: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // martes
  3: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // miércoles
  4: [{ apertura: "09:00", cierre: "13:00" }, { apertura: "17:00", cierre: "21:00" }], // jueves
  5: [{ apertura: "09:00", cierre: "21:00" }], // viernes
  6: [{ apertura: "09:00", cierre: "21:00" }], // sábado
};

module.exports = { SERVICIOS, BARBEROS, HORARIOS_POR_DIA };
