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
    pedidos.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.x' }] }) };
  };

  await whatsapp.sendMessage('5493415551234', 'hola');
  process.env.WHATSAPP_API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0/';
  await whatsapp.sendMessage('5493415551234', 'hola');

  assert.equal(pedidos[0].url, 'https://graph.facebook.com/v21.0/597907523413541/messages');
  assert.equal(pedidos[1].url, 'https://api.kapso.ai/meta/whatsapp/v24.0/597907523413541/messages');
  assert.equal(pedidos[1].auth, 'Bearer token-de-prueba');
  assert.deepEqual(pedidos[1].body, pedidos[0].body);
});
