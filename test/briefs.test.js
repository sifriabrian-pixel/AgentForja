require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const briefs = require('../src/briefs');

const lead = { waId: '5493415551234', nombre: 'Maria Angélica' };

test('búsqueda: reproduce el formato del ejemplo real de Alejandro, en un mensaje limpio (sin Origen)', () => {
  const datos = {
    operacion: 'venta', tipo: 'Monoambiente',
    excluyentes: 'Orientación -> Este, Norte, Oeste, ascensor si son pisos altos, +30m2',
    zonas: 'Facultades o fácil acceso a ellas', destino: 'inversión',
    presupuesto: '40.000', moneda: 'USD', origen: 'directo',
  };
  assert.equal(briefs.briefBusqueda(datos, lead),
    '(BÚSQUEDA VENTA) Monoambiente - Requisitos: Orientación -> Este, Norte, Oeste, ascensor si son pisos altos, +30m2 - Zona: Facultades o fácil acceso a ellas, es para inversión - Presupuesto: u$s 40.000 - Maria Angélica - +5493415551234');
  // El origen va en un segundo mensaje, aparte.
  assert.equal(briefs.notaBusqueda(datos), 'Origen: directo');
  assert.equal(briefs.notaBusqueda({}), 'Origen: directo');
});

test('búsqueda: sin presupuesto ni excluyentes queda "a confirmar" y "sin excluyentes"', () => {
  assert.equal(briefs.briefBusqueda({ operacion: 'venta', tipo: 'departamento', dormitorios: '2', zonas: 'Fisherton' }, lead),
    '(BÚSQUEDA VENTA) departamento, 2 dormitorios - Requisitos: sin excluyentes - Zona: Fisherton - Presupuesto: a confirmar - Maria Angélica - +5493415551234');
});

test('búsqueda: presupuesto tal cual lo dijo el lead; comprar para renta es inversión', () => {
  assert.equal(briefs.textoPresupuesto({ presupuesto: '150 mil dólares', forma_pago: 'crédito' }), '150 mil dólares (crédito)');
  assert.equal(briefs.textoPresupuesto({ presupuesto: '90000000', moneda: 'ARS' }), '$ 90.000.000');
  assert.equal(briefs.textoPresupuesto({ presupuesto: 'a confirmar' }), 'a confirmar');
  assert.match(briefs.briefBusqueda({ operacion: 'venta', tipo: 'departamento', dormitorios: '1', zonas: 'Centro', destino: 'para renta' }, lead),
    /departamento, 1 dormitorio - .* - Zona: Centro, es para inversión - /);
});

test('búsqueda: los obligatorios tienen que estar completos; solo el presupuesto puede quedar a confirmar', () => {
  assert.deepEqual(briefs.faltantesBusqueda({ operacion: 'venta', tipo: 'departamento' }), ['zonas', 'dormitorios']);
  assert.deepEqual(briefs.faltantesBusqueda({ operacion: 'venta', tipo: 'departamento', zonas: 'a confirmar', dormitorios: 'A confirmar' }), ['zonas', 'dormitorios'], '"a confirmar" no vale como zona ni dormitorios');
  assert.deepEqual(briefs.faltantesBusqueda({ operacion: 'venta', tipo: 'a confirmar', zonas: 'Funes' }), ['tipo']);
  assert.deepEqual(briefs.faltantesBusqueda({ operacion: 'venta', tipo: 'lote', zonas: 'Funes' }), [], 'un lote no lleva dormitorios');
  assert.deepEqual(briefs.faltantesBusqueda({ operacion: 'venta', tipo: 'monoambiente', zonas: 'Centro' }), []);
  assert.deepEqual(briefs.faltantesBusqueda({ operacion: 'venta', tipo: 'casa', dormitorios: '3', zonas: 'Funes', presupuesto: 'a confirmar' }), []);
  assert.deepEqual(briefs.faltantesBusqueda({ operacion: 'alquiler', tipo: 'casa', dormitorios: '3', zonas: 'Funes' }), ['operacion'], 'no hay búsquedas de alquiler');
});

test('alquiler temporario: formato del brief y datos obligatorios', () => {
  const propiedad = { id: '8638853', reference_code: 'FAP8638853', operacion: 'Alquiler temporario', direccion: 'Departamento de 2 dormitorios - Juana Manso 400, Puerto Madero' };
  assert.equal(briefs.briefTemporario({ propiedad, fecha_ingreso: '10 de noviembre', fecha_salida: '17 de noviembre', personas: '4' }, lead),
    '(ALQUILER TEMPORARIO) Departamento de 2 dormitorios - Juana Manso 400, Puerto Madero - Cód. Tokko FAP8638853 / 8638853 - Fechas: 10 de noviembre al 17 de noviembre - Personas: 4 - Maria Angélica - +5493415551234');
  assert.deepEqual(briefs.faltantesTemporario({ fecha_ingreso: '10/11' }), ['fecha_salida', 'personas']);
  assert.deepEqual(briefs.faltantesTemporario({ fecha_ingreso: '10/11', fecha_salida: 'a confirmar', personas: 2 }), ['fecha_salida']);
  assert.deepEqual(briefs.faltantesTemporario({ fecha_ingreso: '10/11', fecha_salida: '17/11', personas: 2 }), []);
});

test('visita: título, código Tokko, link, disponibilidad, nombre y teléfono', () => {
  const propiedad = { id: '10496295', reference_code: 'FAP10496295', operacion: 'Venta', direccion: 'Piso exclusivo de 3 dormitorios - Ayacucho 1300', url: 'https://www.forjapropiedades.com/propiedades/venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300' };
  assert.equal(briefs.briefVisita({ propiedad, disponibilidad: 'martes o jueves por la tarde' }, lead),
    '(VISITA VENTA) Piso exclusivo de 3 dormitorios - Ayacucho 1300 - Cód. Tokko FAP10496295 / 10496295 - https://www.forjapropiedades.com/propiedades/venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300 - Disponibilidad: martes o jueves por la tarde - Maria Angélica - +5493415551234');
  assert.match(briefs.briefVisita({ propiedad: { ...propiedad, operacion: 'Alquiler' } }, { waId: '54911', nombre: null }), /^\(VISITA ALQUILER\).*Disponibilidad: a coordinar - sin nombre - \+54911$/);
});

test('atención humana: motivo, resumen en una línea, nombre y teléfono', () => {
  assert.equal(briefs.briefHumano({ motivo: 'colega', resumen: 'Es de otra inmobiliaria,\npregunta si comparten 3 y 3' }, lead),
    '(ATENCIÓN HUMANA - colega) Es de otra inmobiliaria, pregunta si comparten 3 y 3 - Maria Angélica - +5493415551234');
  assert.match(briefs.briefHumano({ motivo: 'pide_humano', resumen: 'Quiere hablar con una persona' }, lead), /^\(ATENCIÓN HUMANA - pide humano\)/);
  assert.match(briefs.briefHumano({ motivo: 'otro', resumen: 'x' }, lead), /^\(ATENCIÓN HUMANA - consulta sin respuesta\)/);
  assert.equal(briefs.briefHumano({ motivo: 'alquiler', resumen: 'Busca alquilar casa en Funes desde marzo' }, lead),
    '(ATENCIÓN HUMANA - alquiler) Busca alquilar casa en Funes desde marzo - Maria Angélica - +5493415551234');
  assert.match(briefs.briefVisita({ propiedad: { id: '1', operacion: 'Alquiler temporario', direccion: 'X', url: 'u' } }, lead), /^\(VISITA ALQUILER\)/);
});

test('visita: si el lead los dijo, el brief suma destino y plazo de compra', () => {
  const propiedad = { id: '10496295', reference_code: 'FAP10496295', operacion: 'Venta', direccion: 'Ayacucho 1300', url: 'https://x' };
  assert.equal(briefs.briefVisita({ propiedad, disponibilidad: 'jueves a la tarde', destino: 'para vivir', plazo: 'en 3 meses' }, lead),
    '(VISITA VENTA) Ayacucho 1300 - Cód. Tokko FAP10496295 / 10496295 - https://x - Disponibilidad: jueves a la tarde - Destino: vivienda - Plazo: en 3 meses - Maria Angélica - +5493415551234');
  assert.match(briefs.briefVisita({ propiedad, destino: 'inversión' }, lead), / - Destino: inversión - Maria Angélica/);
});
