// Textos de derivación que le llegan a Alejandro (spec §5). Funciones puras:
// se arman desde datos estructurados, nunca desde texto libre del LLM.
//
// Alejandro filtra cada lead y lo reenvía a un grupo: el brief es un mensaje
// limpio, listo para reenviar. El origen y cualquier nota interna van aparte
// (notaBusqueda), en un segundo mensaje.
const config = require('../config/forja');
const { slugify } = require('./tokko');

const A_CONFIRMAR = 'a confirmar';
const tiene = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const limpio = (v) => String(v).replace(/\s+/g, ' ').trim();
const esAConfirmar = (v) => tiene(v) && slugify(v) === slugify(A_CONFIRMAR);
// Un obligatorio cuenta solo si trae un dato real.
const completo = (v) => tiene(v) && !esAConfirmar(v);

const telefono = (waId) => `+${String(waId).replace(/\D/g, '')}`;
const operacionMayus = (op) => (slugify(op).startsWith('alquiler') ? 'ALQUILER' : 'VENTA');
const codigoTokko = (p) => (p.reference_code ? `${p.reference_code} / ${p.id}` : p.id);

function llevaDormitorios(tipo) {
  const t = slugify(tipo).replace(/-/g, ' ');
  return !config.tiposSinDormitorios.some((sin) => t.includes(sin));
}

// ─── Búsqueda (§5.1) — solo compra ───────────────────────────────────────────

// Obligatorios: operación (venta), tipo, zona y dormitorios (si aplica). Tienen
// que venir completos; lo único que puede quedar "a confirmar" es el presupuesto.
// Devuelve la lista de los que faltan.
function faltantesBusqueda(d) {
  const faltan = [];
  if (slugify(d.operacion) !== 'venta') faltan.push('operacion');
  if (!completo(d.tipo)) faltan.push('tipo');
  if (!completo(d.zonas)) faltan.push('zonas');
  if (completo(d.tipo) && llevaDormitorios(d.tipo) && !completo(d.dormitorios)) faltan.push('dormitorios');
  return faltan;
}

function textoDormitorios(tipo, dormitorios) {
  if (!completo(dormitorios) || !llevaDormitorios(tipo)) return '';
  const d = limpio(dormitorios);
  // "2" → "2 dormitorios"; "2 o 3" queda como lo dijo el lead.
  if (/^\d+$/.test(d)) return Number(d) === 0 ? '' : `, ${d} ${Number(d) === 1 ? 'dormitorio' : 'dormitorios'}`;
  return /dorm|ambiente/i.test(d) ? `, ${d}` : `, ${d} dormitorios`;
}

// El presupuesto va tal cual lo dijo el lead; no se convierte de moneda.
function textoPresupuesto(d) {
  if (!completo(d.presupuesto)) return A_CONFIRMAR;
  let monto = limpio(d.presupuesto);
  if (/^\d+$/.test(monto)) monto = Number(monto).toLocaleString('es-AR');
  const yaTraeMoneda = /u\$s|usd|d[oó]lar|\$|ars|peso/i.test(monto);
  const simbolo = yaTraeMoneda ? '' : d.moneda === 'USD' ? 'u$s ' : d.moneda === 'ARS' ? '$ ' : '';
  const pago = tiene(d.forma_pago) ? ` (${limpio(d.forma_pago)})` : '';
  return `${simbolo}${monto}${pago}`;
}

// Comprar para alquilar o para renta también es una búsqueda de compra, con destino inversión.
function textoDestino(destino) {
  if (!tiene(destino)) return '';
  const d = slugify(destino);
  if (d.includes('inver') || d.includes('renta')) return ', es para inversión';
  if (d.includes('vivi')) return ', es para vivienda';
  return `, ${limpio(destino)}`;
}

function briefBusqueda(d, { waId, nombre }) {
  const requisitos = tiene(d.excluyentes) ? limpio(d.excluyentes) : 'sin excluyentes';
  return [
    `(BÚSQUEDA VENTA) ${limpio(d.tipo)}${textoDormitorios(d.tipo, d.dormitorios)}`,
    `Requisitos: ${requisitos}`,
    `Zona: ${limpio(d.zonas)}${textoDestino(d.destino)}`,
    `Presupuesto: ${textoPresupuesto(d)}`,
    nombre || 'sin nombre',
    telefono(waId),
  ].join(' - ');
}

// Segundo mensaje, aparte del brief: de dónde salió el lead.
function notaBusqueda(d) {
  return `Origen: ${tiene(d.origen) ? limpio(d.origen) : 'directo'}`;
}

// ─── Visita (§5.2) ───────────────────────────────────────────────────────────

// Destino (vivir / inversión) y forma de pago (contado, crédito o necesita
// vender para comprar) van solo si el lead los dijo.
function briefVisita({ propiedad, disponibilidad, destino, pago }, { waId, nombre }) {
  return [
    `(VISITA ${operacionMayus(propiedad.operacion)}) ${limpio(propiedad.direccion || propiedad.titulo)}`,
    `Cód. Tokko ${codigoTokko(propiedad)}`,
    propiedad.url,
    `Disponibilidad: ${tiene(disponibilidad) ? limpio(disponibilidad) : 'a coordinar'}`,
    tiene(destino) && `Destino: ${textoDestino(destino).replace(/^, (es para )?/, '')}`,
    tiene(pago) && `Pago: ${limpio(pago)}`,
    nombre || 'sin nombre',
    telefono(waId),
  ].filter(Boolean).join(' - ');
}

// ─── Alquiler temporario ─────────────────────────────────────────────────────

// Fechas de ingreso y salida y cantidad de personas: los tres son obligatorios.
function faltantesTemporario(d) {
  return ['fecha_ingreso', 'fecha_salida', 'personas'].filter((k) => !completo(d[k]));
}

function briefTemporario({ propiedad, fecha_ingreso, fecha_salida, personas }, { waId, nombre }) {
  return [
    `(ALQUILER TEMPORARIO) ${limpio(propiedad.direccion || propiedad.titulo)}`,
    `Cód. Tokko ${codigoTokko(propiedad)}`,
    `Fechas: ${limpio(fecha_ingreso)} al ${limpio(fecha_salida)}`,
    `Personas: ${limpio(personas)}`,
    nombre || 'sin nombre',
    telefono(waId),
  ].join(' - ');
}

// ─── Atención humana (§5.3) ──────────────────────────────────────────────────

const MOTIVOS = { colega: 'colega', consulta_sin_respuesta: 'consulta sin respuesta', pide_humano: 'pide humano', alquiler: 'alquiler' };

function briefHumano({ motivo, resumen }, { waId, nombre }) {
  return `(ATENCIÓN HUMANA - ${MOTIVOS[motivo] || MOTIVOS.consulta_sin_respuesta}) ${tiene(resumen) ? limpio(resumen) : 'sin detalle'} - ${nombre || 'sin nombre'} - ${telefono(waId)}`;
}

module.exports = {
  faltantesBusqueda, briefBusqueda, notaBusqueda, briefVisita, faltantesTemporario, briefTemporario, briefHumano,
  textoPresupuesto, llevaDormitorios, telefono, MOTIVOS, A_CONFIRMAR,
};
