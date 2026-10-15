// Tests de punta a punta sin red: webhook → core → agent, con Claude falso a
// nivel SDK y WhatsApp capturado.
const { HANDOFF, P, tmpDbPath, freshDb, fakeClaude, toolThenText, captureSends, waPayload, echoPayload, text, db } = require('./helpers');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const webhook = require('../src/webhook');
const agent = require('../src/agent');
const repo = require('../src/repo');
const core = require('../src/core');
const handoff = require('../src/handoff');
const whatsapp = require('../src/whatsapp');
const config = require('../config/forja');

const WA = '5493415558888';
const VISITA = toolThenText('derivar_visita', { propiedad_id: P.ayacucho, disponibilidad: 'sábado a la mañana', nombre: 'Ana' }, config.MSG_VISITA_DERIVADA);

// Alejandro le escribió al número hace un momento: tiene la ventana de 24 hs abierta.
const abrirVentana = () => handoff.registrarEntrante();

async function entra(from, msg, opts) {
  webhook.handlePayload(waPayload(from, msg, opts));
  await agent.idle();
}

beforeEach(() => freshDb());
afterEach(() => {
  delete process.env.HANDOFF_TEMPLATE_NAME;
  delete process.env.FOLLOWUP_TEMPLATE_NAME;
  delete process.env.NODE_ENV;
  delete process.env.DB_PATH;
});

test('mensaje entrante: responde al lead y le manda el brief a Alejandro', async () => {
  const sent = captureSends();
  fakeClaude(VISITA);
  abrirVentana();
  await entra(WA, text('quiero visitar el de Ayacucho, puedo el sábado a la mañana'));

  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, HANDOFF);
  assert.match(sent[0].text, /^\(VISITA VENTA\) Piso exclusivo de 3 dormitorios - Ayacucho 1300 - .* - Disponibilidad: sábado a la mañana - Ana - \+5493415558888$/);
  assert.deepEqual(sent[1], { to: WA, text: config.MSG_VISITA_DERIVADA });
  assert.equal(repo.derivacionesDe(repo.getCurrentLead(WA).id)[0].status, 'enviado');
});

test('Meta reenvía el mismo mensaje: no hay segunda respuesta ni segundo aviso', async () => {
  const sent = captureSends();
  const calls = fakeClaude(VISITA);
  abrirVentana();
  const msg = text('quiero visitar', { id: 'wamid.repetido' });
  await entra(WA, msg);
  await entra(WA, msg);
  assert.equal(sent.length, 2);
  assert.equal(calls.length, 2, 'una sola vuelta de herramienta + respuesta');
});

test('el anuncio (referral) se guarda aunque el primer mensaje sea un audio', async () => {
  captureSends();
  const calls = fakeClaude(toolThenText(null, null, 'Buenas tardes ¿me dirías tu nombre?'));
  await entra(WA, { type: 'audio', audio: { id: 'media-1' } }, { referral: { source_id: 'ad-9', source_type: 'ad', headline: 'Piso exclusivo en Ayacucho 1300', source_url: 'https://fb.me/x' } });
  const lead = repo.getCurrentLead(WA);
  assert.equal(lead.source, 'ctwa');
  assert.equal(lead.ad_id, 'ad-9');
  assert.match(calls[0].system[1].text, /Texto del anuncio: "Piso exclusivo en Ayacucho 1300"/);
});

test('si el aviso a Alejandro falla, se reintenta después y no se duplica', async () => {
  let caido = true;
  const sent = captureSends({ fallar: ({ to }) => caido && to === HANDOFF });
  fakeClaude(VISITA);
  abrirVentana();
  await entra(WA, text('quiero visitar'));
  assert.deepEqual(sent.map((s) => s.to), [WA], 'el lead recibe su respuesta aunque el aviso haya fallado');
  const lead = repo.getCurrentLead(WA);
  assert.equal(repo.derivacionesDe(lead.id)[0].status, 'fallido');

  caido = false;
  assert.equal(await agent.retryNotices(), 1);
  assert.equal(sent[1].to, HANDOFF);
  assert.equal(await agent.retryNotices(), 0);
  assert.equal(sent.length, 2);
});

const BUSQUEDA = toolThenText('derivar_busqueda', { operacion: 'venta', tipo: 'casa', dormitorios: '3', zonas: 'Funes', nombre: 'Marcos' }, config.MSG_BUSQUEDA_DERIVADA);

test('búsqueda: a Alejandro le llegan dos mensajes, el brief limpio y aparte el origen', async () => {
  const sent = captureSends();
  fakeClaude(BUSQUEDA);
  abrirVentana();
  await entra(WA, text('busco casa de 3 dormitorios en Funes'));
  assert.deepEqual(sent, [
    { to: HANDOFF, text: '(BÚSQUEDA VENTA) casa, 3 dormitorios - Requisitos: sin excluyentes - Zona: Funes - Presupuesto: a confirmar - Marcos - +5493415558888' },
    { to: HANDOFF, text: 'Origen: directo' },
    { to: WA, text: 'Perfecto, vamos a derivar la búsqueda al asesor de ventas para que te contacte y evalúen opciones' },
  ]);
});

test('si la nota falla, el brief no se repite', async () => {
  const sent = captureSends({ fallar: ({ text: t }) => /^Origen:/.test(t || '') });
  fakeClaude(BUSQUEDA);
  abrirVentana();
  await entra(WA, text('busco casa'));
  const lead = repo.getCurrentLead(WA);
  assert.equal(repo.derivacionesDe(lead.id)[0].status, 'enviado');
  assert.equal(await agent.retryNotices(), 0);
  assert.equal(sent.filter((s) => s.to === HANDOFF).length, 1);
  assert.ok(repo.events(lead.id).some((e) => e.type === 'handoff_note_failed'));
});

// ─── Esquema híbrido: ventana de 24 hs de Alejandro ──────────────────────────

const BRIEF_BUSQUEDA = '(BÚSQUEDA VENTA) casa, 3 dormitorios - Requisitos: sin excluyentes - Zona: Funes - Presupuesto: a confirmar - Marcos - +5493415558888';
const aAlejandro = (sent) => sent.filter((s) => s.to === HANDOFF);
const boton = () => ({ type: 'button', button: { text: 'Recibir para reenviar', payload: 'Recibir para reenviar' } });

test('ventana cerrada: sale la plantilla con el brief; al tocar el botón llega limpio, con el origen aparte', async () => {
  process.env.HANDOFF_TEMPLATE_NAME = 'forja_aviso_lead';
  const sent = captureSends();
  fakeClaude(BUSQUEDA);
  await entra(WA, text('busco casa de 3 dormitorios en Funes'));

  assert.deepEqual(aAlejandro(sent), [{ to: HANDOFF, template: 'forja_aviso_lead', idioma: 'es_AR', params: { 1: BRIEF_BUSQUEDA } }], 'nada de texto libre con la ventana cerrada');
  const lead = repo.getCurrentLead(WA);
  assert.equal(repo.derivacionesDe(lead.id)[0].status, 'avisado', 'el brief queda guardado hasta que Alejandro responda');
  assert.equal(await agent.retryNotices(), 0, 'el reintento no manda otra plantilla');

  await entra(HANDOFF, boton());
  assert.deepEqual(aAlejandro(sent).slice(1), [{ to: HANDOFF, text: BRIEF_BUSQUEDA }, { to: HANDOFF, text: 'Origen: directo' }]);
  assert.equal(repo.derivacionesDe(lead.id)[0].status, 'enviado');

  // Toca el botón de nuevo (o Meta reenvía el toque): no se reenvía nada.
  await entra(HANDOFF, boton());
  await entra(HANDOFF, boton());
  assert.equal(aAlejandro(sent).length, 3);
});

test('dos derivaciones con la ventana cerrada: un solo toque entrega las dos, cada una en su mensaje', async () => {
  process.env.HANDOFF_TEMPLATE_NAME = 'forja_aviso_lead';
  const sent = captureSends();
  fakeClaude(VISITA);
  await entra(WA, text('quiero visitar'));
  fakeClaude(BUSQUEDA);
  await entra('5493415559999', text('busco casa'));
  assert.deepEqual(aAlejandro(sent).map((s) => s.template), ['forja_aviso_lead', 'forja_aviso_lead']);

  // Dos toques casi simultáneos: igual llega cada brief una sola vez.
  webhook.handlePayload(waPayload(HANDOFF, boton()));
  webhook.handlePayload(waPayload(HANDOFF, boton()));
  await agent.idle();
  const limpios = aAlejandro(sent).slice(2).map((s) => s.text);
  assert.equal(limpios.length, 3);
  assert.match(limpios[0], /^\(VISITA VENTA\)/);
  assert.match(limpios[1], /^\(BÚSQUEDA VENTA\).*\+5493415559999$/);
  assert.equal(limpios[2], 'Origen: directo');
});

test('una vez que Alejandro respondió, los briefs siguientes salen directo como texto (ventana abierta)', async () => {
  process.env.HANDOFF_TEMPLATE_NAME = 'forja_aviso_lead';
  const sent = captureSends();
  await entra(HANDOFF, text('hola'));
  assert.equal(sent.length, 0, 'a Alejandro no se le responde como a un lead');
  fakeClaude(VISITA);
  await entra(WA, text('quiero visitar'));
  assert.equal(aAlejandro(sent).length, 1);
  assert.match(aAlejandro(sent)[0].text, /^\(VISITA VENTA\)/);
  assert.equal(aAlejandro(sent)[0].template, undefined);
});

test('ventana cerrada y sin plantilla configurada: no se manda nada; el brief espera a que Alejandro escriba', async () => {
  const sent = captureSends();
  fakeClaude(VISITA);
  await entra(WA, text('quiero visitar'));
  assert.equal(aAlejandro(sent).length, 0);
  const lead = repo.getCurrentLead(WA);
  assert.equal(repo.derivacionesDe(lead.id)[0].status, 'pendiente');
  assert.equal(await agent.retryNotices(), 0);
  assert.equal(repo.derivacionesDe(lead.id)[0].attempts, 0, 'esperar no gasta reintentos');

  await entra(HANDOFF, text('buenas'));
  assert.equal(aAlejandro(sent).length, 1);
  assert.equal(repo.derivacionesDe(lead.id)[0].status, 'enviado');
});

test('si la plantilla falla se reintenta; nunca cae a texto libre con la ventana cerrada', async () => {
  process.env.HANDOFF_TEMPLATE_NAME = 'forja_aviso_lead';
  let caida = true;
  const sent = captureSends({ fallar: ({ template }) => caida && Boolean(template) });
  fakeClaude(VISITA);
  await entra(WA, text('quiero visitar'));
  assert.equal(aAlejandro(sent).length, 0);
  caida = false;
  assert.equal(await agent.retryNotices(), 1);
  assert.equal(aAlejandro(sent)[0].template, 'forja_aviso_lead');
});

test('la variable de la plantilla va en una sola línea y con largo acotado', () => {
  assert.equal(handoff.variablePlantilla('uno\ndos\t tres    cuatro'), 'uno dos tres cuatro');
  assert.equal(handoff.variablePlantilla('x'.repeat(2000)).length, 900);
});

test('lead que escribe durante la pausa sin respuesta humana: se le avisa a Alejandro una sola vez por pausa', async () => {
  const sent = captureSends();
  abrirVentana();
  fakeClaude(toolThenText('derivar_a_humano', { motivo: 'pide_humano', resumen: 'Quiere hablar con una persona', nombre: 'Rocío' }, 'Te paso con un asesor.'));
  await entra(WA, text('quiero hablar con una persona'));
  assert.equal(aAlejandro(sent).length, 1);

  await entra(WA, text('hola? hay alguien?'));
  await entra(WA, text('sigo esperando'));
  const avisos = aAlejandro(sent).slice(1);
  assert.deepEqual(avisos, [{ to: HANDOFF, text: 'El lead Rocío (+5493415558888) volvió a escribir: "hola? hay alguien?"' }]);
  assert.equal(sent.filter((s) => s.to === WA).length, 1, 'al lead no se le responde en pausa');
  const lead = repo.getCurrentLead(WA);
  assert.equal(core.buildState(lead).derivaciones.length, 1, 'el aviso no cuenta como otra derivación');

  // Nueva pausa más adelante (#reanudar y #pausa): vuelve a avisar una vez.
  core.command(`#reanudar ${WA}`);
  await new Promise((r) => setTimeout(r, 5));
  core.command(`#pausa ${WA}`);
  await entra(WA, text('buenas'));
  await entra(WA, text('?'));
  assert.equal(aAlejandro(sent).filter((s) => /volvió a escribir/.test(s.text || '')).length, 2);
});

test('si una persona ya le respondió al lead (echo), no se molesta a Alejandro con el aviso', async () => {
  const sent = captureSends();
  abrirVentana();
  fakeClaude(toolThenText(null, null, 'hola'));
  await entra(WA, text('hola'));
  webhook.handlePayload(echoPayload(WA, 'Hola, soy Alejandro'));
  await entra(WA, text('dale'));
  assert.equal(aAlejandro(sent).length, 0);

  // Derivado a humano y después la persona responde: tampoco.
  fakeClaude(toolThenText('derivar_a_humano', { motivo: 'pide_humano', resumen: 'x' }, 'ok'));
  await entra('5493415557000', text('una persona por favor'));
  webhook.handlePayload(echoPayload('5493415557000', 'Hola, te atiendo yo'));
  await entra('5493415557000', text('genial'));
  assert.equal(aAlejandro(sent).filter((s) => /volvió a escribir/.test(s.text || '')).length, 0);
});

test('echo de coexistencia: Alejandro escribe a mano y el agente se calla en ese chat', async () => {
  const sent = captureSends();
  const calls = fakeClaude(toolThenText(null, null, 'Buenas tardes ¿me dirías tu nombre?'));
  await entra(WA, text('hola'));
  assert.equal(sent.length, 1);

  webhook.handlePayload(echoPayload(WA, 'Hola, soy Alejandro. Te llamo en 5 minutos.'));
  await entra(WA, text('dale, te espero'));
  assert.equal(sent.length, 1, 'el agente no responde');
  assert.equal(calls.length, 1);
  assert.equal(repo.getCurrentLead(WA).pause_reason, 'echo');

  // Otro chat sigue funcionando normal.
  await entra('5493415550001', text('hola'));
  assert.equal(sent.length, 2);
});

test('comandos: solo valen desde HANDOFF_WHATSAPP; ese número nunca es tratado como lead', async () => {
  const sent = captureSends();
  const calls = fakeClaude(toolThenText(null, null, 'respuesta del agente'));
  await entra(WA, text('hola'));

  // Otro número manda el comando: es un mensaje común de un lead, no pausa a nadie.
  await entra('5493415550002', text(`#pausa ${WA}`));
  assert.equal(repo.isPaused(repo.getCurrentLead(WA)), false);
  assert.equal(calls.length, 2);

  // Alejandro (llega como 54341… o 549341…: es el mismo número).
  webhook.handlePayload(waPayload(whatsapp.normalizeTo(HANDOFF), text(`#pausa ${WA}`)));
  await new Promise((r) => setImmediate(r));
  assert.equal(repo.isPaused(repo.getCurrentLead(WA)), true);
  assert.match(sent[sent.length - 1].text, /no responde más/);
  await entra(WA, text('hola?'));
  assert.equal(calls.length, 2, 'en pausa no se llama a Claude');

  webhook.handlePayload(waPayload(HANDOFF, text(`#reanudar ${WA}`)));
  await entra(WA, text('hola de nuevo'));
  assert.equal(calls.length, 3);

  // Un mensaje común de Alejandro se ignora: no se crea un lead ni se le responde.
  const antes = sent.length;
  await entra(HANDOFF, text('gracias'));
  assert.equal(sent.length, antes);
  assert.equal(repo.getCurrentLead(HANDOFF), null);
});

test('job de seguimiento: envía la plantilla una vez aunque corra dos veces', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  const sent = captureSends();
  fakeClaude(toolThenText(null, null, 'hola'));
  await entra(WA, text('hola'));
  const lead = repo.getCurrentLead(WA);
  assert.equal(await agent.runFollowups(), 0, 'todavía no venció');

  // Se adelanta el vencimiento (y la última actividad) como si hubieran pasado 5 días.
  const hace5dias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  db.get().prepare('UPDATE followups SET due_at = ? WHERE lead_id = ?').run(new Date(Date.now() - 60000).toISOString(), lead.id);
  db.get().prepare('UPDATE leads SET last_inbound_at = ? WHERE id = ?').run(hace5dias, lead.id);
  const enFranja = (() => { const h = require('../src/seguimiento').horaLocal(); return h >= config.seguimiento.franja.desde && h < config.seguimiento.franja.hasta; })();

  const [a, b] = await Promise.all([agent.runFollowups(), agent.runFollowups()]);
  const plantillas = sent.filter((s) => s.template === 'forja_seguimiento');
  if (enFranja) {
    assert.equal(a + b, 1);
    assert.equal(plantillas.length, 1);
    assert.equal(plantillas[0].to, WA);
    assert.equal(repo.getFollowup(lead.id).status, 'sent');
    assert.equal(await agent.runFollowups(), 0);
  } else {
    assert.equal(plantillas.length, 0, 'fuera de la franja horaria no se envía');
  }
});

test('la base sobrevive a un reinicio: historial, derivaciones y seguimiento programado', async () => {
  const ruta = tmpDbPath();
  await freshDb(ruta);
  captureSends();
  fakeClaude(toolThenText(null, null, 'hola'));
  await entra(WA, text('hola'));
  const leadId = repo.getCurrentLead(WA).id;

  db.close(); // "redeploy"
  db.open(ruta);
  assert.equal(repo.getCurrentLead(WA).id, leadId);
  assert.equal(repo.history(WA).length, 2);
  assert.equal(repo.getFollowup(leadId).status, 'pending');
  assert.equal(core.buildState(repo.getCurrentLead(WA)).followup.status, 'pending');
});

test('en producción la base no arranca sin DB_PATH ni con una ruta dentro del código', () => {
  process.env.NODE_ENV = 'production';
  assert.throws(() => db.defaultPath(), /DB_PATH no está definido/);
  process.env.DB_PATH = path.join(__dirname, '..', 'data', 'forja.sqlite');
  assert.throws(() => db.defaultPath(), /dentro de la carpeta del código/);
  process.env.DB_PATH = path.join(path.parse(__dirname).root, 'data', 'forja.sqlite');
  assert.equal(db.defaultPath(), process.env.DB_PATH);
});

// ─── Formato propio de Kapso (sandbox) ───────────────────────────────────────

const kapsoRecibido = (from, body, { id = `wamid.k.${Math.random()}`, name = 'Lead Kapso' } = {}) => ({
  message: { id, timestamp: '1730092800', type: 'text', from, text: { body }, kapso: { direction: 'inbound', status: 'received', origin: 'cloud_api', has_media: false, content: body } },
  conversation: { id: 'conv_1', contact_name: name, phone_number: from, phone_number_id: '597907523413541' },
  is_new_conversation: true,
  phone_number_id: '597907523413541',
});

test('Kapso: un mensaje recibido en formato Kapso se atiende igual que uno de Meta', async () => {
  const sent = captureSends();
  abrirVentana();
  const calls = fakeClaude(VISITA);
  webhook.handlePayload(kapsoRecibido(WA, 'quiero visitar el de Ayacucho', { id: 'wamid.kapso.1' }));
  await agent.idle();
  assert.equal(calls.length, 2);
  assert.match(aAlejandro(sent)[0].text, /^\(VISITA VENTA\)/);
  assert.deepEqual(sent.filter((s) => s.to === WA).map((s) => s.text), [config.MSG_VISITA_DERIVADA]);
  assert.equal(repo.getCurrentLead(WA).nombre_perfil, 'Lead Kapso');

  // Reenvío del mismo mensaje: no se responde dos veces.
  webhook.handlePayload(kapsoRecibido(WA, 'quiero visitar el de Ayacucho', { id: 'wamid.kapso.1' }));
  await agent.idle();
  assert.equal(calls.length, 2);
});

test('Kapso: lotes, mensajes salientes y comandos de Alejandro', async () => {
  const sent = captureSends();
  const calls = fakeClaude(toolThenText(null, null, 'hola'));
  // Un lote con un entrante y un saliente: solo cuenta el entrante.
  const saliente = { message: { id: 'wamid.out', type: 'text', to: WA, text: { body: 'hola' }, kapso: { direction: 'outbound' } }, phone_number_id: '597907523413541' };
  webhook.handlePayload({ type: 'whatsapp.message.received', batch: true, data: [kapsoRecibido(WA, 'hola'), saliente], batch_info: { size: 2 } });
  await agent.idle();
  assert.equal(calls.length, 1);
  assert.equal(sent.filter((s) => s.to === WA).length, 1);

  // Alejandro escribe por Kapso: abre su ventana y el comando funciona.
  webhook.handlePayload(kapsoRecibido(HANDOFF, `#pausa ${WA}`));
  await agent.idle();
  assert.equal(repo.isPaused(repo.getCurrentLead(WA)), true);
  assert.equal(handoff.ventanaAbierta(), true);
});
