// Utilidades de test: base temporal, Claude falso y WhatsApp capturado.
process.env.WHATSAPP_DRY_RUN = '1';
process.env.RETRY_BASE_MS = '10';
process.env.ESPERA_MENSAJES_MS = '0';
process.env.HANDOFF_WHATSAPP = '5493415550000';
for (const k of ['TOKKO_API_KEY', 'WHATSAPP_TOKEN', 'FOLLOWUP_TEMPLATE_NAME', 'HANDOFF_TEMPLATE_NAME', 'FOLLOWUP_DAYS', 'HUMAN_TAKEOVER_HOURS', 'ENABLE_PROPERTY_SEARCH', 'AGENT_IDENTITY', 'DB_PATH', 'NODE_ENV', 'RAILWAY_ENVIRONMENT']) delete process.env[k];

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');
const claude = require('../src/claude');
const whatsapp = require('../src/whatsapp');
const tokko = require('../src/tokko');

const HANDOFF = process.env.HANDOFF_WHATSAPP;

// IDs de las fichas de fixtures/tokko-fichas.json
const P = {
  ayacucho: '10496295',      // venta, depto Rosario, USD 300.000, sin expensas cargadas
  kentucky: '8563856',       // venta, casa USD 980.000
  aurea: '10326813',         // alquiler, Fisherton, ARS 1.200.000, con expensas
  roldan: '10502893',        // alquiler, casa en Roldán, USD 1.800
  madero: '8638798',         // venta, Puerto Madero (Buenos Aires)
  reservada: '7162783',      // venta, casa en Funes Hills — RESERVADA
  puertoNorte: '11170708',   // alquiler, Puerto Norte (la ficha no dice nada de mascotas)
  temporario: '8638853',     // alquiler temporario, Puerto Madero
};

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-test-'));
  return path.join(dir, 'forja.sqlite');
}

// Abre una base nueva en memoria con el catálogo de fixtures cargado.
async function freshDb(dbPath = ':memory:') {
  db.close();
  db.open(dbPath);
  await tokko.sync();
  return db;
}

// LLM guionado para el core: cada paso es una función (handlers, contexto,
// historial) → texto de la respuesta. Puede llamar a las herramientas.
function scriptedLlm(...pasos) {
  const llamadas = [];
  let i = 0;
  return {
    llamadas,
    chat: async (historial, contexto, handlers) => {
      llamadas.push({ historial: JSON.parse(JSON.stringify(historial)), contexto });
      const paso = pasos[Math.min(i, pasos.length - 1)];
      i += 1;
      const texto = typeof paso === 'function' ? await paso(handlers, contexto, historial) : paso;
      return { texto, stopReason: 'end_turn' };
    },
  };
}

// Claude falso a nivel SDK (para los tests que pasan por agent.js / webhook.js):
// `responder(params, n)` devuelve la respuesta cruda de cada llamada.
function fakeClaude(responder) {
  const calls = [];
  claude.setClient({
    beta: {
      messages: {
        create: async (params) => {
          calls.push(JSON.parse(JSON.stringify(params)));
          return responder(params, calls.length);
        },
      },
    },
  });
  return calls;
}

// Primera vuelta llama a una herramienta; después responde el texto.
function toolThenText(name, input, texto) {
  return (params) => {
    const last = params.messages[params.messages.length - 1];
    const vieneDeTool = Array.isArray(last.content) && last.content[0]?.type === 'tool_result';
    if (!vieneDeTool && name) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${Math.random()}`, name, input }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: texto }] };
  };
}

function captureSends({ fallar = () => false } = {}) {
  const sent = [];
  whatsapp.sendMessage = async (to, text) => {
    if (fallar({ to, text })) throw new Error('WhatsApp API 500: falla simulada');
    sent.push({ to, text });
    return { messages: [{ id: `wamid.out.${sent.length}.${Math.random()}` }] };
  };
  whatsapp.sendTemplate = async (to, template, idioma, params) => {
    if (fallar({ to, template })) throw new Error('WhatsApp API 400: plantilla no aprobada');
    sent.push({ to, template, idioma, params });
    return { messages: [{ id: `wamid.tpl.${sent.length}.${Math.random()}` }] };
  };
  return sent;
}

let seq = 0;
function waPayload(from, msg, { name = 'Cliente Test', referral = null } = {}) {
  seq += 1;
  const m = { from, id: msg.id || `wamid.in.${Date.now()}.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...msg };
  if (referral) m.referral = referral;
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name } }], messages: [m] } }] }],
  };
}

// Echo de coexistencia: alguien escribió desde la app con el número de Forja.
function echoPayload(to, body, id) {
  seq += 1;
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ from: '5493410000000', to, id: id || `wamid.echo.${seq}`, type: 'text', text: { body } }] } }] }],
  };
}

const text = (body, extra = {}) => ({ type: 'text', text: { body }, ...extra });

// Lunes 12 de octubre de 2026, 15:00 en Argentina (UTC-3).
const T0 = '2026-10-12T18:00:00.000Z';
const masHoras = (iso, h) => new Date(new Date(iso).getTime() + h * 3600 * 1000).toISOString();
const masDias = (iso, d) => masHoras(iso, d * 24);

module.exports = { HANDOFF, P, T0, masHoras, masDias, tmpDbPath, freshDb, scriptedLlm, fakeClaude, toolThenText, captureSends, waPayload, echoPayload, text, db };
