// Reloj del agente. En producción es la hora real. El QA puede fijar la hora
// de un turno con run(), sin afectar a otras conversaciones que corran a la vez.
const { AsyncLocalStorage } = require('async_hooks');

const fijado = new AsyncLocalStorage();

function nowISO() {
  return fijado.getStore() || new Date().toISOString();
}

function date() {
  return new Date(nowISO());
}

// Ejecuta fn con la hora fijada en `iso` (ISO 8601). Sin `iso`, corre con la hora real.
function run(iso, fn) {
  return iso ? fijado.run(new Date(iso).toISOString(), fn) : fn();
}

module.exports = { nowISO, date, run };
