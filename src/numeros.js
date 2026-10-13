// Comparación de números de WhatsApp. El mismo celular argentino puede llegar
// como 549341… (webhook) o 54341… (como hay que enviarlo): se comparan iguales.
const { normalizeTo } = require('./whatsapp');

const digitos = (n) => String(n || '').replace(/\D/g, '');

function canonico(n) {
  return normalizeTo(digitos(n));
}

function mismoNumero(a, b) {
  const x = canonico(a);
  const y = canonico(b);
  return Boolean(x) && x === y;
}

// Para cuando alguien tipea el número a mano, sin código de país ("341 5907951").
function coincideFinal(completo, parcial) {
  const x = canonico(completo);
  const y = digitos(parcial).replace(/^0+/, '');
  return y.length >= 8 && x.endsWith(y);
}

module.exports = { digitos, canonico, mismoNumero, coincideFinal };
