const { P, T0, masHoras, masDias, freshDb, scriptedLlm } = require('./helpers');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const repo = require('../src/repo');
const clock = require('../src/clock');
const config = require('../config/forja');

const WA = '5493415557777';
let n = 0;
const msg = (text, now = T0) => ({ conversationId: WA, from: WA, text, now, messageId: `s.${n += 1}` });
const DIA5 = masDias(T0, 5); // lunes 15:00 + 5 días = sábado 15:00 (dentro de la franja)

// El seguimiento es solo para quien recibió la ficha de una unidad en venta y no
// contestó: el primer turno de estos tests manda la ficha de Ayacucho.
const conFicha = (primero, ...resto) => scriptedLlm(async (h, c, hist) => {
  await h.get_property({ referencia: P.ayacucho });
  return typeof primero === 'function' ? primero(h, c, hist) : primero;
}, ...resto);

// Como el adapter de WhatsApp: si hay que enviar, confirma el envío.
async function tick(now, { ok = true } = {}) {
  const out = await core.tick(WA, now);
  for (const a of out.actions) core.confirmFollowup(a.payload, { ok, error: ok ? null : 'plantilla no aprobada' });
  return { ...out, followup: repo.getFollowup(repo.getCurrentLead(WA).id) };
}

// Estos tests fijan el seguimiento en 5 días; el valor por defecto (23 h) tiene su propio test.
beforeEach(() => { process.env.FOLLOWUP_DAYS = '5'; return freshDb(); });
afterEach(() => {
  delete process.env.FOLLOWUP_TEMPLATE_NAME;
  delete process.env.FOLLOWUP_DAYS;
});

test('por defecto un solo toque a las 23 h; FOLLOWUP_HOURS o FOLLOWUP_DAYS lo cambian', () => {
  delete process.env.FOLLOWUP_DAYS;
  assert.deepEqual(config.FOLLOWUP_DAYS, [23 / 24]);
  process.env.FOLLOWUP_HOURS = '23, 72';
  assert.deepEqual(config.FOLLOWUP_DAYS, [23 / 24, 3]);
  delete process.env.FOLLOWUP_HOURS;
  process.env.FOLLOWUP_DAYS = '7, 3';
  assert.deepEqual(config.FOLLOWUP_DAYS, [3, 7], 'FOLLOWUP_DAYS manda');
  process.env.FOLLOWUP_DAYS = '[3,7]';
  assert.deepEqual(config.FOLLOWUP_DAYS, [3, 7]);
  process.env.FOLLOWUP_DAYS = 'cualquier cosa';
  assert.deepEqual(config.FOLLOWUP_DAYS, [23 / 24]);
});

test('recibió la ficha y no contestó: al día siguiente le escribe retomando la ficha, como mensaje común', async () => {
  delete process.env.FOLLOWUP_DAYS; // valor por defecto: 23 h
  const llm = scriptedLlm(async (h) => { await h.get_property({ referencia: P.ayacucho }); return 'Te paso la ficha. ¿Me dirías tu nombre?'; });
  const o1 = await core.handleMessage(msg('me interesa el de Ayacucho'), { llm });
  assert.equal(o1.state.followup.dueAt, masHoras(T0, 23));

  assert.deepEqual((await tick(masHoras(T0, 22))).actions, [], 'todavía no');
  const out = await tick(masHoras(T0, 23));
  assert.equal(out.actions[0].payload.via, 'texto', 'dentro de la ventana de 24 h: sin plantilla');
  assert.match(out.messages[0], /^Buenas tardes ¿cómo estás\? Te saluda el asistente de Forja Propiedades\. ¿Pudiste ver la ficha\? ¿Se ajusta a lo que buscás\?$/);
  assert.equal(out.followup.status, 'sent');
  assert.deepEqual((await tick(masHoras(T0, 47))).actions, [], 'un solo seguimiento');
});

test('sin ficha de una unidad en venta no hay seguimiento (sin unidad, o alquiler)', async () => {
  delete process.env.FOLLOWUP_DAYS;
  const o1 = await core.handleMessage(msg('hola, busco algo en Fisherton'), { llm: scriptedLlm('¿Estás buscando para comprar o para alquilar?') });
  assert.equal(o1.state.followup, null);

  const WA2 = '5493415550099';
  const llm = scriptedLlm(async (h) => { await h.get_property({ referencia: P.aurea }); return 'Te paso la ficha. ¿Me dirías tu nombre?'; });
  const o2 = await core.handleMessage({ conversationId: WA2, from: WA2, text: 'me interesa Aurea', now: T0, messageId: 'alq.1' }, { llm });
  assert.equal(o2.state.propiedadId, P.aurea);
  assert.equal(o2.state.followup, null, 'en alquiler no hay seguimiento');
});

test('se programa al mandar la ficha; si el lead contesta, se cancela y no se vuelve a programar', async () => {
  const llm = conFicha('Te paso la ficha. ¿Me dirías tu nombre?', '¿La buscás para vivir o como inversión?');
  const o1 = await core.handleMessage(msg('me interesa el de Ayacucho'), { llm });
  assert.deepEqual(o1.state.followup, { status: 'pending', dueAt: DIA5, reason: null, enviados: 0 });

  const o2 = await core.handleMessage(msg('Martina', masDias(T0, 2)), { llm });
  assert.deepEqual({ status: o2.state.followup.status, reason: o2.state.followup.reason }, { status: 'cancelled', reason: 'lead_escribio' }, 'contestó: ya no corresponde');
  assert.deepEqual((await tick(masDias(T0, 9))).actions, []);
});

test('con dos toques configurados (3 y 7 días) salen dos mensajes y ninguno más', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  process.env.FOLLOWUP_DAYS = '3,7';
  const llm = conFicha('hola', 'dale, cualquier cosa avisame');
  await core.handleMessage(msg('hola'), { llm });

  assert.deepEqual((await tick(masDias(T0, 2))).actions, []);
  const primero = await tick(masDias(T0, 3));
  assert.equal(primero.actions.length, 1);
  assert.deepEqual({ status: primero.followup.status, step: primero.followup.step, due: primero.followup.due_at }, { status: 'pending', step: 1, due: masDias(T0, 7) });

  assert.deepEqual((await tick(masDias(T0, 5))).actions, [], 'entre un toque y otro no sale nada');
  const segundo = await tick(masDias(T0, 7));
  assert.equal(segundo.actions.length, 1);
  assert.deepEqual({ status: segundo.followup.status, step: segundo.followup.step }, { status: 'sent', step: 2 });

  // Aunque vuelva a conversar, ya recibió todos los toques.
  const o = await core.handleMessage(msg('hola de nuevo', masDias(T0, 8)), { llm });
  assert.equal(o.state.followup.status, 'sent');
  assert.deepEqual((await tick(masDias(T0, 20))).actions, []);
});

test('programar_seguimiento: sin ficha de una unidad en venta no agenda nada', async () => {
  let r;
  const llm = scriptedLlm(async (h) => { r = await h.programar_seguimiento({ motivo: 'solo miraba' }); return 'Perfecto, cualquier cosa acá estamos.'; });
  const out = await core.handleMessage(msg('no, gracias, solo miraba'), { llm });
  assert.match(r, /No se agenda seguimiento \(sin ficha\)/, 'sin ficha de venta no hay seguimiento');
  assert.equal(out.state.followup, null);
});

test('sin plantilla configurada: fuera de la ventana de 24 hs no se manda nada (ni texto libre)', async () => {
  await core.handleMessage(msg('hola'), { llm: conFicha('hola') });
  assert.deepEqual((await tick(masDias(T0, 4))).messages, [], 'todavía no toca');

  const out = await tick(DIA5);
  assert.deepEqual(out.messages, []);
  assert.deepEqual(out.actions, []);
  assert.equal(out.meta.skipped, 'sin_plantilla');
  assert.equal(out.followup.status, 'pending');

  await tick(masHoras(DIA5, 1));
  const lead = repo.getCurrentLead(WA);
  assert.equal(repo.events(lead.id).filter((e) => e.type === 'followup_skipped').length, 1, 'se registra una sola vez, no cada 15 minutos');

  // Si la plantilla nunca se configura, a los 2 días de vencido se cancela.
  assert.deepEqual((await tick(masDias(DIA5, 2.5))).followup.reason, 'vencido');
});

test('con plantilla: se envía por plantilla, una sola vez, y nunca más a ese lead', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  const llm = conFicha('hola', '¿Te interesa?', 'bueno');
  await core.handleMessage(msg('hola'), { llm });

  const out = await tick(DIA5);
  assert.deepEqual(out.messages, ['Hola ¿cómo estás? Te saluda el asistente de Forja Propiedades. ¿Pudiste ver la ficha? ¿Se ajusta a lo que buscás?']);
  assert.equal(out.actions[0].type, 'send_followup');
  assert.deepEqual({ via: out.actions[0].payload.via, plantilla: out.actions[0].payload.plantilla, idioma: out.actions[0].payload.idioma, params: out.actions[0].payload.params },
    { via: 'plantilla', plantilla: 'forja_seguimiento', idioma: 'es_AR', params: {} });
  assert.equal(out.followup.status, 'sent');

  assert.deepEqual((await tick(masHoras(DIA5, 1))).actions, [], 'la segunda pasada del job no reenvía');

  // El lead responde al seguimiento: el agente lo sabe y retoma la conversación.
  const o2 = await core.handleMessage(msg('sí, la vi, me interesa', masHoras(DIA5, 3)), { llm });
  assert.match(llm.llamadas[1].contexto, /Tu último mensaje fue el de seguimiento/);
  assert.match(llm.llamadas[1].historial.map((m) => m.content).join('\n'), /Pudiste ver la ficha/);
  assert.equal(o2.state.followup.status, 'sent', 'ya recibió su seguimiento: no se programa otro');

  await core.handleMessage(msg('no, dejá', masHoras(DIA5, 4)), { llm });
  assert.deepEqual((await tick(masDias(DIA5, 6))).actions, [], 'ningún lead recibe más de un seguimiento');
});

test('dos pasadas simultáneas del job: solo una toma el envío', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  await core.handleMessage(msg('hola'), { llm: conFicha('hola') });
  const [a, b] = await Promise.all([core.tick(WA, DIA5), core.tick(WA, DIA5)]);
  assert.equal(a.actions.length + b.actions.length, 1);
});

test('si la plantilla falla (no aprobada), queda como fallido y no se reintenta ni se manda texto', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  await core.handleMessage(msg('hola'), { llm: conFicha('hola') });
  const out = await tick(DIA5, { ok: false });
  assert.equal(out.followup.status, 'failed');
  assert.match(out.followup.reason, /no aprobada/);
  assert.deepEqual((await tick(masHoras(DIA5, 1))).actions, []);
  assert.equal(repo.history(WA).some((m) => m.type === 'followup'), false, 'un envío fallido no queda en el historial');
});

test('dentro de la ventana de 24 hs (FOLLOWUP_DAYS corto) se envía como texto, sin plantilla', async () => {
  process.env.FOLLOWUP_DAYS = '0.125'; // 3 horas
  await core.handleMessage(msg('hola'), { llm: conFicha('hola') });
  const out = await tick(masHoras(T0, 3));
  assert.equal(out.actions[0].payload.via, 'texto');
  assert.equal(out.followup.status, 'sent');
});

test('fuera de la franja horaria espera; no se manda de madrugada', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  const noche = '2026-10-13T02:30:00.000Z'; // 23:30 en Argentina
  await core.handleMessage(msg('hola', noche), { llm: conFicha('hola') });
  const aLas2330 = await tick(masDias(noche, 5));
  assert.equal(aLas2330.meta.skipped, 'fuera_de_franja');
  const aLas10 = await tick(masHoras(masDias(noche, 5), 10.5)); // 10:00 del día siguiente
  assert.equal(aLas10.followup.status, 'sent');
  assert.match(aLas10.messages[0], /^Hola ¿cómo estás/, 'por plantilla sale el texto aprobado, sin saludo por hora');
});

test('no hay seguimiento para leads derivados, colegas ni quienes pidieron no ser contactados', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';

  // Derivado: el seguimiento que estaba programado se cancela.
  const llm = conFicha('hola', async (h) => { await h.derivar_visita({ propiedad_id: P.ayacucho }); return config.MSG_VISITA_DERIVADA; });
  await core.handleMessage(msg('hola'), { llm });
  const o2 = await core.handleMessage(msg('quiero visitar el de Ayacucho', masHoras(T0, 1)), { llm });
  assert.deepEqual({ status: o2.state.followup.status, reason: o2.state.followup.reason }, { status: 'cancelled', reason: 'derivado' });
  assert.deepEqual((await tick(masDias(T0, 6))).actions, []);
  // Aunque siga conversando, no se vuelve a programar.
  const o3 = await core.handleMessage(msg('gracias', masHoras(T0, 2)), { llm: scriptedLlm('de nada') });
  assert.equal(o3.state.followup.status, 'cancelled');
});

test('cancelar_seguimiento: el lead pide que no lo contacten', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  const llm = conFicha('hola', async (h) => { await h.cancelar_seguimiento({}); return 'Entendido, que tengas buen día.'; });
  await core.handleMessage(msg('hola'), { llm });
  const out = await core.handleMessage(msg('no me escriban más', masHoras(T0, 1)), { llm });
  assert.equal(out.state.datos.no_contactar, true);
  assert.equal(out.state.followup.reason, 'no_contactar');
  assert.deepEqual((await tick(masDias(T0, 6))).actions, []);
});

test('si una persona tomó la conversación, el seguimiento automático no sale', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  await core.handleMessage(msg('hola'), { llm: conFicha('hola') });
  core.command(`#pausa ${WA}`, { now: masDias(T0, 1) });
  const out = await tick(DIA5);
  assert.deepEqual(out.actions, []);
  assert.equal(out.followup.reason, 'intervencion_humana');
});

test('ficha de noche: el seguimiento se adelanta a las 19:50 del día siguiente para salir sin plantilla', async () => {
  delete process.env.FOLLOWUP_DAYS; // 23 h
  const noche = '2026-10-13T01:00:00.000Z'; // lunes 22:00 en Argentina
  const o = await core.handleMessage(msg('me interesa el de Ayacucho', noche), { llm: conFicha('Te paso la ficha. ¿Me dirías tu nombre?') });
  assert.equal(o.state.followup.dueAt, '2026-10-13T22:50:00.000Z', 'martes 19:50 en Argentina (21 h 50 después)');
  const out = await tick('2026-10-13T22:50:00.000Z');
  assert.equal(out.actions[0].payload.via, 'texto', 'dentro de la ventana de 24 h');
  assert.equal(out.followup.status, 'sent');
});

test('ficha de madrugada: no se adelanta a menos de una hora; espera a la franja', async () => {
  delete process.env.FOLLOWUP_DAYS;
  const madrugada = '2026-10-13T10:30:00.000Z'; // martes 07:30 en Argentina → 23 h = miércoles 06:30
  const o = await core.handleMessage(msg('me interesa el de Ayacucho', madrugada), { llm: conFicha('Te paso la ficha. ¿Me dirías tu nombre?') });
  assert.equal(o.state.followup.dueAt, '2026-10-13T22:50:00.000Z', 'martes 19:50: 12 h 20 después, el mismo día');
});
