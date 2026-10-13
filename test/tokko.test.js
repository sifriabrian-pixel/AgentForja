const { P, freshDb, db } = require('./helpers');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tokko = require('../src/tokko');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tokko-fichas.json'), 'utf8')).objects;
const ficha = (id) => JSON.parse(JSON.stringify(fixtures.find((f) => String(f.id) === id)));

const fetchReal = global.fetch;
// Tokko falso: responde el listado paginado y la ficha puntual.
function fakeTokko({ objetos = fixtures, porId = {}, fallar = false } = {}) {
  const pedidos = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    pedidos.push(u.pathname + u.search);
    if (fallar) return { ok: false, status: 500, json: async () => ({}) };
    assert.equal(u.searchParams.get('key'), 'clave-de-prueba');
    const unidad = u.pathname.match(/\/property\/(\d+)\/$/);
    if (unidad) {
      const f = porId[unidad[1]] !== undefined ? porId[unidad[1]] : objetos.find((o) => String(o.id) === unidad[1]);
      return f ? { ok: true, status: 200, json: async () => f } : { ok: false, status: 404, json: async () => ({}) };
    }
    const offset = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    return { ok: true, status: 200, json: async () => ({ meta: { total_count: objetos.length }, objects: objetos.slice(offset, offset + limit) }) };
  };
  return pedidos;
}

beforeEach(() => freshDb());
afterEach(() => {
  global.fetch = fetchReal;
  delete process.env.TOKKO_API_KEY;
});

test('el slug se arma igual que en la web: operación + dirección publicada', () => {
  assert.equal(tokko.slugDe('Venta', 'Casa en Barrio Kentucky Club de Campo'), 'venta-casa-en-barrio-kentucky-club-de-campo');
  assert.equal(tokko.slugDe('Alquiler', '3 dormitorios + comodín - San Sebastián'), 'alquiler-3-dormitorios-comodin-san-sebastian');
  assert.equal(tokko.slugDe('Alquiler', 'Alquiler - Casa 3 Dorm. Amoblada con Pileta en Barrio Cielo, Roldan - 1.800 USD'), 'alquiler-alquiler-casa-3-dorm-amoblada-con-pileta-en-barrio-cielo-roldan-1-800-usd');
  // Los fixtures traen el link real de la web: el slug calculado tiene que coincidir.
  for (const f of fixtures) assert.equal(`https://www.forjapropiedades.com/propiedades/${tokko.mapear(f).slug}`, f.public_url);
});

test('identifica la unidad por link de la web, id, código, link de portal y texto', () => {
  const id = (ref) => tokko.buscar(ref).propiedad?.id;
  assert.equal(id('https://www.forjapropiedades.com/propiedades/venta-casa-en-barrio-kentucky-club-de-campo'), P.kentucky);
  assert.equal(id('forjapropiedades.com/propiedades/venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300?utm_source=ig'), P.ayacucho);
  assert.equal(id(`https://www.forjapropiedades.com/propiedades/venta-titulo-repetido-${P.madero}`), P.madero, 'slug repetido: termina en el id de Tokko');
  assert.equal(id(P.aurea), P.aurea);
  assert.equal(id('fap10326813'), P.aurea, 'código de referencia, sin importar mayúsculas');
  assert.equal(id(`https://www.zonaprop.com.ar/propiedades/casa-en-roldan-FHO${P.roldan}.html`), P.roldan, 'link de portal que trae el código');
  assert.equal(id('Hola, me interesa la propiedad "Piso exclusivo de 3 dormitorios - Ayacucho 1300".'), P.ayacucho, 'mensaje prearmado de la web');
  assert.equal(id('la casa de Kentucky'), P.kentucky);
});

test('texto ambiguo devuelve candidatas; texto sin relación no devuelve nada', () => {
  const res = tokko.buscar('un departamento');
  assert.equal(res.propiedad, undefined);
  assert.ok(res.candidatas.length >= 2);
  assert.deepEqual(tokko.buscar('hola buenas tardes'), {});
  assert.deepEqual(tokko.buscar(''), {});
});

test('la ficha para el agente no trae datos vacíos: los lista en sin_dato', () => {
  const f = tokko.fichaParaAgente(tokko.get(P.ayacucho));
  assert.equal(f.precio, 'USD 300.000');
  assert.equal(f.estado, 'disponible');
  assert.equal(f.expensas, undefined);
  assert.ok(f.sin_dato.includes('expensas'), 'las expensas no están cargadas en Tokko');
  const alquiler = tokko.fichaParaAgente(tokko.get(P.aurea));
  assert.equal(alquiler.precio, 'ARS 1.200.000 por mes');
  assert.equal(alquiler.expensas, 'ARS 295.000');
  assert.equal(tokko.get(P.reservada).estado, 'reservada');
});

test('sync contra la API: pagina, y lo que ya no viene queda como no disponible', async () => {
  process.env.TOKKO_API_KEY = 'clave-de-prueba';
  const muchas = Array.from({ length: 120 }, (_, i) => ({ ...ficha(P.ayacucho), id: 900000 + i, fake_address: `Calle Falsa ${i}`, reference_code: `X${i}` }));
  const pedidos = fakeTokko({ objetos: muchas });
  const res = await tokko.sync();
  assert.deepEqual(res, { source: 'api', total: 120 });
  assert.equal(pedidos.length, 3, 'tres páginas de 50');
  assert.equal(tokko.get('900119').direccion, 'Calle Falsa 119');
  assert.equal(tokko.get(P.kentucky).estado, 'no_disponible', 'la ficha vieja no se borra: queda como no disponible');
});

test('si la API de Tokko falla, el catálogo local queda como estaba', async () => {
  process.env.TOKKO_API_KEY = 'clave-de-prueba';
  fakeTokko({ fallar: true });
  await assert.rejects(() => tokko.sync(), /Tokko API 500/);
  assert.equal(tokko.get(P.kentucky).estado, 'disponible');
  const log = db.get().prepare('SELECT * FROM sync_log ORDER BY rowid DESC LIMIT 1').get();
  assert.match(log.error, /500/);
});

test('refrescar trae estado y precio actuales de esa unidad', async () => {
  process.env.TOKKO_API_KEY = 'clave-de-prueba';
  const cambiada = ficha(P.kentucky);
  cambiada.status = 3;
  cambiada.operations[0].prices[0].price = 950000;
  const pedidos = fakeTokko({ porId: { [P.kentucky]: cambiada } });

  const { propiedad, verificada } = await tokko.refrescar(P.kentucky);
  assert.equal(verificada, true);
  assert.equal(propiedad.estado, 'reservada');
  assert.equal(propiedad.precio, 950000);

  await tokko.refrescar(P.kentucky);
  assert.equal(pedidos.length, 1, 'dentro de los 5 minutos no vuelve a consultar');
});

test('refrescar: unidad dada de baja en Tokko, API caída y sin API key', async () => {
  assert.deepEqual((await tokko.refrescar(P.madero)).verificada, false, 'sin API key no se puede verificar');

  process.env.TOKKO_API_KEY = 'clave-de-prueba';
  fakeTokko({ porId: { [P.madero]: null } });
  assert.equal((await tokko.refrescar(P.madero)).propiedad.estado, 'no_disponible');

  fakeTokko({ fallar: true });
  const res = await tokko.refrescar(P.aurea);
  assert.equal(res.verificada, false);
  assert.equal(res.propiedad.estado, 'disponible', 'devuelve lo que había, marcado como sin verificar');
});
