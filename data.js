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

module.exports = { SERVICIOS, BARBEROS };
