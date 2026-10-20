// Firma del webhook (Meta o Kapso) y dirección de la API (Meta o Kapso).
require('./helpers');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const whatsapp = require('../src/whatsapp');

const cuerpo = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
const hmac = (secreto) => crypto.createHmac('sha256', secreto).update(cuerpo).digest('hex');
const fetchReal = global.fetch;

afterEach(() => {
  for (const k of ['WHATSAPP_APP_SECRET', 'KAPSO_WEBHOOK_SECRET', 'WHATSAPP_API_BASE', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']) delete process.env[k];
  process.env.WHATSAPP_DRY_RUN = '1';
  global.fetch = fetchReal;
});

test('firma de Meta: X-Hub-Signature-256 con el App Secret', () => {
  process.env.WHATSAPP_DRY_RUN = '';
  process.env.WHATSAPP_APP_SECRET = 'secreto-meta';
  assert.equal(whatsapp.verifySignature(cuerpo, { 'x-hub-signature-256': `sha256=${hmac('secreto-meta')}` }), true);
  assert.equal(whatsapp.verifySignature(cuerpo, { 'x-hub-signature-256': `sha256=${hmac('otro')}` }), false);
  assert.equal(whatsapp.verifySignature(cuerpo, {}), false);
});

test('firma de Kapso: X-Webhook-Signature (hex, sin prefijo) con el secret del webhook', () => {
  process.env.WHATSAPP_DRY_RUN = '';
  process.env.KAPSO_WEBHOOK_SECRET = 'secreto-kapso';
  assert.equal(whatsapp.verifySignature(cuerpo, { 'x-webhook-signature': hmac('secreto-kapso') }), true);
  assert.equal(whatsapp.verifySignature(cuerpo, { 'x-webhook-signature': hmac('secreto-kapso').toUpperCase() }), true);
  assert.equal(whatsapp.verifySignature(cuerpo, { 'x-webhook-signature': hmac('otro') }), false);
  assert.equal(whatsapp.verifySignature(cuerpo, { 'x-hub-signature-256': `sha256=${hmac('secreto-kapso')}` }), false, 'con solo el secreto de Kapso, una firma estilo Meta no pasa');
});

test('sin ningún secreto el webhook rechaza todo (salvo en modo prueba)', () => {
  process.env.WHATSAPP_DRY_RUN = '';
  assert.equal(whatsapp.verifySignature(cuerpo, { 'x-webhook-signature': hmac('x') }), false);
  process.env.WHATSAPP_DRY_RUN = '1';
  assert.equal(whatsapp.verifySignature(cuerpo, {}), true);
});

test('los mensajes salen por Meta o por Kapso según WHATSAPP_API_BASE, con el mismo formato', async () => {
  process.env.WHATSAPP_DRY_RUN = '';
  process.env.WHATSAPP_TOKEN = 'token-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '597907523413541';
  const pedidos = [];
  global.fetch = async (url, opts) => {
    pedidos.push({ url, auth: opts.headers.Authorization, apiKey: opts.headers['X-API-Key'], body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.x' }] }) };
  };

  await whatsapp.sendMessage('5493415551234', 'hola');
  process.env.WHATSAPP_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0/';
  await whatsapp.sendMessage('5493415551234', 'hola');

  assert.equal(pedidos[0].url, 'https://graph.facebook.com/v21.0/597907523413541/messages');
  assert.equal(pedidos[1].url, 'https://api.kapso.ai/meta/whatsapp/v24.0/597907523413541/messages');
  assert.equal(pedidos[0].auth, 'Bearer token-de-prueba', 'Meta: Bearer');
  assert.equal(pedidos[1].apiKey, 'token-de-prueba', 'Kapso: la API key va en X-API-Key');
  assert.equal(pedidos[1].auth, undefined, 'Kapso: sin Bearer (lo rechaza con 401)');
  const { to: _a, ...cuerpoMeta } = pedidos[0].body;
  const { to: _b, ...cuerpoKapso } = pedidos[1].body;
  assert.deepEqual(cuerpoKapso, cuerpoMeta, 'mismo pedido; solo cambia cómo va el número (ver el test siguiente)');
});

test('con Kapso el número se envía tal cual llegó (sin quitar el 9)', async () => {
  process.env.WHATSAPP_DRY_RUN = '';
  process.env.WHATSAPP_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '597907523413541';
  const tos = [];
  global.fetch = async (_url, opts) => { tos.push(JSON.parse(opts.body).to); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await whatsapp.sendMessage('5493415551234', 'hola');
  delete process.env.WHATSAPP_API_BASE;
  await whatsapp.sendMessage('5493415551234', 'hola');
  assert.deepEqual(tos, ['5493415551234', '543415551234']);
});

test('Kapso: si rechaza por la ventana de 24 hs apenas entró el mensaje, reintenta una vez', async () => {
  process.env.WHATSAPP_DRY_RUN = '';
  process.env.KAPSO_RETRY_MS = '1';
  process.env.WHATSAPP_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1426503647210628';
  const ventana = { ok: false, status: 422, text: async () => '{"error":"Cannot send non-template messages outside the 24-hour window."}' };
  const bien = { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.ok' }] }) };

  let n = 0;
  global.fetch = async () => (n++ === 0 ? ventana : bien);
  assert.equal((await whatsapp.sendMessage('5493415551234', 'hola')).messages[0].id, 'wamid.ok');
  assert.equal(n, 2);

  // Si sigue cerrada, falla (no reintenta para siempre).
  n = 0;
  global.fetch = async () => { n += 1; return ventana; };
  await assert.rejects(() => whatsapp.sendMessage('5493415551234', 'hola'), /422/);
  assert.equal(n, 2);

  // Otro 422 (payload inválido) no se reintenta.
  n = 0;
  global.fetch = async () => { n += 1; return { ok: false, status: 422, text: async () => '{"error":"Invalid message payload"}' }; };
  await assert.rejects(() => whatsapp.sendMessage('5493415551234', 'hola'), /Invalid message payload/);
  assert.equal(n, 1);
  delete process.env.KAPSO_RETRY_MS;
});
