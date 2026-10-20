// Catálogo de Forja en Tokko Broker.
//
//   sync()              baja todo el catálogo a la tabla local `propiedades` (cada TOKKO_SYNC_HOURS)
//   buscar(referencia)  identifica una unidad en la tabla local: id de Tokko, código de
//                       referencia, link de la web (slug), link de portal o texto del anuncio
//   refrescar(id)       vuelve a pedir ESA unidad a la API (estado y precio actuales);
//                       se usa antes de confirmarle disponibilidad al lead
//
// Sin TOKKO_API_KEY el catálogo sale de fixtures/tokko-fichas.json (mismo formato
// que devuelve la API) y refrescar() devuelve lo que hay en la tabla.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const clock = require('./clock');
const config = require('../config/forja');

const apiKey = () => process.env.TOKKO_API_KEY || '';
const PAGINA = 50;

// ─── Slugs de la web ─────────────────────────────────────────────────────────

function slugify(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Misma regla que forjapropiedades.com (verificada contra sus 359 fichas):
// operación + dirección publicada. Cuando dos fichas chocan, la web le agrega
// "-{id de Tokko}" al final; eso lo resuelve buscar().
function slugDe(operacion, direccion) {
  // La web solo distingue alquiler y venta (un "Alquiler temporario" va como alquiler).
  const clase = claseOperacion(operacion);
  const palabra = clase === 'venta' ? 'venta' : clase ? 'alquiler' : String(operacion || '').trim().split(' ')[0];
  return slugify(`${palabra} ${direccion}`);
}

// Cómo trata el agente cada tipo de operación de Tokko: 'venta' | 'alquiler' |
// 'temporario'. El mapeo está en config.tokko.operaciones; null si no lo conoce.
function claseOperacion(nombre) {
  return config.tokko.operaciones[slugify(nombre).replace(/-/g, ' ')] || null;
}

// ─── API de Tokko → fila local ───────────────────────────────────────────────

const numero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function mapear(p) {
  const operaciones = (p.operations || []).map((o) => {
    const precio = (o.prices || [])[0] || {};
    return { operacion: o.operation_type, precio: numero(precio.price), moneda: precio.currency || null };
  });
  const principal = operaciones[0] || {};
  const direccion = p.fake_address || p.address || p.publication_title || '';
  const slug = slugDe(principal.operacion || '', direccion);
  return {
    id: String(p.id),
    reference_code: p.reference_code || null,
    titulo: p.publication_title || null,
    direccion,
    slug,
    operacion: principal.operacion || null,
    precio: principal.precio || null,
    moneda: principal.moneda || null,
    operaciones: JSON.stringify(operaciones),
    tipo: p.type?.name || null,
    zona: p.location?.name || null,
    ubicacion: p.location?.full_location || null,
    sucursal: p.branch?.name || null,
    // En Tokko, suite_amount son los dormitorios y room_amount los ambientes.
    dormitorios: numero(p.suite_amount),
    banos: numero(p.bathroom_amount),
    ambientes: numero(p.room_amount),
    cocheras: numero(p.parking_lot_amount),
    sup_total: numero(p.total_surface) || numero(p.surface),
    sup_cubierta: numero(p.roofed_surface),
    expensas: numero(p.expenses),
    antiguedad: Number.isFinite(Number(p.age)) ? Number(p.age) : null,
    orientacion: p.orientation || null,
    disposicion: p.disposition || null,
    caracteristicas: JSON.stringify((p.tags || []).map((t) => t.name).filter(Boolean)),
    descripcion: (p.description || '').trim() || null,
    url: `${config.web}/propiedades/${slug}`,
    estado: p.deleted_at ? 'no_disponible' : (config.tokko.estados[p.status] || 'no_disponible'),
  };
}

const COLUMNAS = ['id', 'reference_code', 'titulo', 'direccion', 'slug', 'operacion', 'precio', 'moneda', 'operaciones', 'tipo', 'zona',
  'ubicacion', 'sucursal', 'dormitorios', 'banos', 'ambientes', 'cocheras', 'sup_total', 'sup_cubierta', 'expensas', 'antiguedad',
  'orientacion', 'disposicion', 'caracteristicas', 'descripcion', 'url', 'estado'];

function upsert(fila, { refrescada = false } = {}) {
  const ts = clock.nowISO();
  db.get().prepare(`
    INSERT INTO propiedades (${COLUMNAS.join(', ')}, synced_at, refreshed_at)
    VALUES (${COLUMNAS.map((c) => `@${c}`).join(', ')}, @ts, @refreshed)
    ON CONFLICT (id) DO UPDATE SET ${COLUMNAS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')},
      synced_at = excluded.synced_at, refreshed_at = COALESCE(excluded.refreshed_at, propiedades.refreshed_at)
  `).run({ ...fila, ts, refreshed: refrescada ? ts : null });
}

// ─── Llamadas a la API ───────────────────────────────────────────────────────

async function apiGet(ruta, params = {}) {
  const url = new URL(`${config.tokko.api}${ruta}`);
  for (const [k, v] of Object.entries({ key: apiKey(), lang: 'es_ar', format: 'json', ...params })) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Tokko API ${res.status}`);
  return res.json();
}

async function bajarCatalogo() {
  const fichas = [];
  for (let offset = 0; ; offset += PAGINA) {
    const pagina = await apiGet('/property/', { limit: PAGINA, offset });
    const objetos = pagina?.objects || [];
    fichas.push(...objetos);
    const total = pagina?.meta?.total_count ?? fichas.length;
    if (!objetos.length || fichas.length >= total) break;
  }
  return fichas;
}

function leerFixtures(archivo = config.tokko.fixtures) {
  const ruta = path.isAbsolute(archivo) ? archivo : path.join(__dirname, '..', archivo);
  return JSON.parse(fs.readFileSync(ruta, 'utf8')).objects || [];
}

// ─── Sync ────────────────────────────────────────────────────────────────────

// Baja el catálogo completo. Las fichas que ya no vienen quedan como
// 'no_disponible' (no se borran: un lead puede llegar por un link viejo).
// Si la API falla, la tabla queda como estaba.
async function sync({ fixtures } = {}) {
  const usarApi = Boolean(apiKey()) && !fixtures;
  const source = usarApi ? 'api' : 'fixtures';
  const conn = db.get();
  try {
    const fichas = usarApi ? await bajarCatalogo() : leerFixtures(fixtures);
    const filas = fichas.map(mapear);
    conn.transaction(() => {
      filas.forEach((f) => upsert(f));
      const vistos = new Set(filas.map((f) => f.id));
      const faltan = conn.prepare("SELECT id FROM propiedades WHERE estado != 'no_disponible'").all().filter((r) => !vistos.has(r.id));
      const baja = conn.prepare("UPDATE propiedades SET estado = 'no_disponible', synced_at = ? WHERE id = ?");
      faltan.forEach((r) => baja.run(clock.nowISO(), r.id));
      conn.prepare('INSERT INTO sync_log (id, source, total, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), source, filas.length, clock.nowISO());
    })();
    return { source, total: filas.length };
  } catch (e) {
    conn.prepare('INSERT INTO sync_log (id, source, error, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), source, e.message, clock.nowISO());
    throw e;
  }
}

// ─── Lectura local ───────────────────────────────────────────────────────────

function parse(row) {
  if (!row) return null;
  return { ...row, operaciones: JSON.parse(row.operaciones || '[]'), caracteristicas: JSON.parse(row.caracteristicas || '[]') };
}

function get(id) {
  return parse(db.get().prepare('SELECT * FROM propiedades WHERE id = ?').get(String(id)));
}

const todas = () => db.get().prepare('SELECT * FROM propiedades').all().map(parse);

const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'al', 'con', 'y', 'a', 'por', 'para', 'un', 'una', 'me', 'interesa',
  'propiedad', 'hola', 'quiero', 'info', 'informacion', 'consulta', 'venta', 'alquiler', 'forja', 'propiedades', 'https', 'http', 'www', 'com']);
const palabras = (texto) => slugify(texto).split('-').filter((w) => w && !VACIAS.has(w));

// Identifica una unidad a partir de lo que haya: id, código, link o texto.
// Devuelve { propiedad, por } si hay una sola coincidencia clara,
// { candidatas } si hay varias parecidas, o {} si no encontró nada.
function buscar(referencia) {
  const texto = String(referencia || '').trim();
  if (!texto) return {};
  const props = todas();
  if (!props.length) return {};

  // 1. Link de la web de Forja: /propiedades/{slug}
  const enlace = texto.match(/\/propiedades\/([a-z0-9-]+)/i);
  const slug = enlace ? enlace[1].toLowerCase() : (/^[a-z0-9]+(-[a-z0-9]+)+$/i.test(texto) ? texto.toLowerCase() : null);
  if (slug) {
    const exacta = props.filter((p) => p.slug === slug);
    if (exacta.length === 1) return { propiedad: exacta[0], por: 'slug' };
    // Slug repetido en la web: termina en "-{id de Tokko}".
    const conId = slug.match(/^(.*)-(\d{5,})$/);
    if (conId) {
      const p = props.find((x) => x.id === conId[2]);
      if (p) return { propiedad: p, por: 'slug' };
    }
    if (exacta.length > 1) return { candidatas: exacta };
  }

  // 2. Código de referencia o id de Tokko, sueltos o dentro de un link de portal.
  const fichas = texto.toUpperCase().match(/[A-Z0-9]{4,}/g) || [];
  const porCodigo = props.filter((p) => p.reference_code && fichas.includes(p.reference_code.toUpperCase()));
  if (porCodigo.length === 1) return { propiedad: porCodigo[0], por: 'codigo' };
  const numeros = texto.match(/\d{5,}/g) || [];
  const porId = props.filter((p) => numeros.includes(p.id));
  if (porId.length === 1) return { propiedad: porId[0], por: 'id' };

  // 3. Texto libre (título del anuncio, dirección, "la de Ayacucho"): se compara
  //    contra dirección, título y zona. Un link de la web que no matcheó exacto
  //    (cambió el título) también cae acá, con las palabras del slug.
  const buscadas = [...new Set(palabras(slug || texto))];
  if (!buscadas.length) return {};
  const puntuadas = props.map((p) => {
    const propias = new Set(palabras(`${p.direccion} ${p.titulo || ''} ${p.zona || ''}`));
    const comunes = buscadas.filter((w) => propias.has(w));
    // Un número de calle o una palabra larga pesan más que una palabra común.
    const peso = comunes.reduce((s, w) => s + (/\d/.test(w) ? 2 : w.length >= 6 ? 1.5 : 1), 0);
    return { p, comunes: comunes.length, peso, cobertura: comunes.length / buscadas.length };
  }).filter((x) => x.comunes > 0).sort((a, b) => b.peso - a.peso);

  if (!puntuadas.length) return {};
  const [mejor, segunda] = puntuadas;
  const clara = mejor.peso >= 2.5 && mejor.cobertura >= 0.5 && (!segunda || mejor.peso >= segunda.peso * 1.5);
  if (clara) return { propiedad: mejor.p, por: 'texto' };
  const candidatas = puntuadas.filter((x) => x.peso >= Math.max(1.5, mejor.peso * 0.6)).slice(0, 3).map((x) => x.p);
  return candidatas.length ? { candidatas } : {};
}

// Búsqueda por filtros en la cartera (fase 2, detrás de ENABLE_PROPERTY_SEARCH).
function filtrar({ operacion, tipo, zona, dormitorios_min, precio_max, moneda } = {}) {
  const z = zona ? palabras(zona) : [];
  return todas().filter((p) => p.estado === 'disponible')
    .filter((p) => !operacion || slugify(p.operacion) === slugify(operacion))
    .filter((p) => !tipo || slugify(p.tipo).includes(slugify(tipo)))
    .filter((p) => !z.length || z.some((w) => palabras(`${p.zona} ${p.ubicacion} ${p.direccion}`).includes(w)))
    .filter((p) => !dormitorios_min || (p.dormitorios || 0) >= dormitorios_min)
    .filter((p) => !precio_max || (p.precio && p.precio <= precio_max && (!moneda || p.moneda === moneda)))
    .slice(0, 5);
}

// ─── Refresco puntual ────────────────────────────────────────────────────────

// Vuelve a pedir la unidad a Tokko. Devuelve { propiedad, verificada }:
// verificada = false si no hay API key o la API falló (el dato puede estar viejo).
async function refrescar(id) {
  const local = get(id);
  if (!apiKey()) return { propiedad: local, verificada: false };
  const vigencia = config.tokko.refrescoMinutos * 60 * 1000;
  if (local?.refreshed_at && clock.date() - new Date(local.refreshed_at) < vigencia) return { propiedad: local, verificada: true };
  try {
    const ficha = await apiGet(`/property/${id}/`);
    if (!ficha) {
      // Ya no existe en Tokko: se dio de baja.
      db.get().prepare("UPDATE propiedades SET estado = 'no_disponible', refreshed_at = ? WHERE id = ?").run(clock.nowISO(), String(id));
    } else {
      upsert(mapear(ficha), { refrescada: true });
    }
    return { propiedad: get(id), verificada: true };
  } catch (e) {
    console.error(`[tokko] No se pudo refrescar la unidad ${id}:`, e.message);
    return { propiedad: local, verificada: false };
  }
}

// ─── Ficha para el agente ────────────────────────────────────────────────────

const miles = (n) => Math.round(n).toLocaleString('es-AR');

// Lo que ve Claude: solo datos que están en Tokko. Lo que falta va en
// `sin_dato`, para que no lo invente.
function fichaParaAgente(p) {
  const ficha = {
    id: p.id,
    codigo: p.reference_code,
    estado: p.estado,
    operacion: p.operacion,
    // venta | alquiler | temporario (alquiler por días o semanas)
    modalidad: claseOperacion(p.operacion),
    tipo: p.tipo,
    direccion: p.direccion,
    zona: p.zona,
    ubicacion: p.ubicacion,
    precio: p.precio ? `${p.moneda} ${miles(p.precio)}${claseOperacion(p.operacion) === 'alquiler' ? ' por mes' : ''}` : null,
    otras_operaciones: p.operaciones.slice(1).map((o) => `${o.operacion}: ${o.moneda} ${o.precio ? miles(o.precio) : 'consultar'}`),
    dormitorios: p.dormitorios,
    banos: p.banos,
    ambientes: p.ambientes,
    cocheras: p.cocheras,
    superficie_total_m2: p.sup_total,
    superficie_cubierta_m2: p.sup_cubierta,
    expensas: p.expensas ? `ARS ${miles(p.expensas)}` : null,
    // Convención de Tokko: -1 = en construcción, 0 = a estrenar.
    antiguedad: p.antiguedad === -1 ? 'en construcción' : p.antiguedad === 0 ? 'a estrenar' : p.antiguedad > 0 ? `${p.antiguedad} años` : null,
    orientacion: p.orientacion,
    disposicion: p.disposicion,
    caracteristicas: p.caracteristicas,
    descripcion: p.descripcion,
    link: p.url,
  };
  const sinDato = Object.entries(ficha).filter(([, v]) => v === null || v === undefined || v === '').map(([k]) => k);
  for (const k of sinDato) delete ficha[k];
  if (!ficha.otras_operaciones.length) delete ficha.otras_operaciones;
  if (!ficha.caracteristicas.length) delete ficha.caracteristicas;
  ficha.sin_dato = sinDato;
  return ficha;
}

// Ficha lista para WhatsApp, armada en código con los datos de Tokko (nada
// inventado). El agente le suma una línea "✨" con uno o dos diferenciales.
function fichaWhatsApp(p) {
  const partes = String(p.ubicacion || '').split('|').map((s) => s.trim()).filter(Boolean);
  // full_location: "Argentina | Santa Fe | Rosario | Fisherton". Si la ciudad
  // coincide con el barrio, se muestra la provincia ("Capital Federal" = Buenos Aires).
  const nombre = (s) => (s === 'Capital Federal' ? 'Buenos Aires' : s);
  const ciudad = [partes[2], partes[1]].map(nombre).find((s) => s && slugify(s) !== slugify(p.zona)) || null;
  const lugar = [p.zona, ciudad].filter(Boolean).join(', ');
  const clase = claseOperacion(p.operacion);
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  const ambientes = [
    p.dormitorios ? plural(p.dormitorios, 'dormitorio', 'dormitorios') : p.ambientes ? plural(p.ambientes, 'ambiente', 'ambientes') : null,
    p.banos ? plural(p.banos, 'baño', 'baños') : null,
    p.cocheras ? plural(p.cocheras, 'cochera', 'cocheras') : null,
  ].filter(Boolean).join(' · ');
  const superficie = [
    p.sup_total ? `${miles(p.sup_total)} m² totales` : null,
    p.sup_cubierta && p.sup_cubierta !== p.sup_total ? `${miles(p.sup_cubierta)} m² cubiertos` : null,
  ].filter(Boolean).join(' · ');
  const antiguedad = p.antiguedad === -1 ? 'En construcción' : p.antiguedad === 0 ? 'A estrenar' : p.antiguedad > 0 ? `${p.antiguedad} años de antigüedad` : null;
  const operacion = clase === 'temporario' ? 'Alquiler temporario' : clase === 'alquiler' ? 'Alquiler' : 'Venta';
  return [
    `🏠 *${p.direccion || p.titulo}*`,
    lugar && `📍 ${lugar}`,
    p.precio && `💰 ${operacion} · ${p.moneda} ${miles(p.precio)}${clase === 'alquiler' ? ' por mes' : ''}`,
    ambientes && `🛏️ ${ambientes}`,
    superficie && `📐 ${superficie}`,
    p.expensas && `🧾 Expensas: ARS ${miles(p.expensas)}`,
    antiguedad && `🏗️ ${antiguedad}`,
    p.url && `🔗 ${p.url}`,
  ].filter(Boolean).join('\n');
}

function resumen(p) {
  return { id: p.id, codigo: p.reference_code, operacion: p.operacion, tipo: p.tipo, direccion: p.direccion, zona: p.zona, precio: p.precio ? `${p.moneda} ${miles(p.precio)}` : null, estado: p.estado };
}

module.exports = { sync, buscar, filtrar, refrescar, get, slugify, slugDe, claseOperacion, mapear, fichaParaAgente, fichaWhatsApp, resumen };
