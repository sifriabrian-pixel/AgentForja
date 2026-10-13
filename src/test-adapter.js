// Adapter de test: corre el core real sobre una base en memoria y solo
// registra lo que el agente habría enviado. No usa whatsapp.js: no puede mandar nada.
//
//   const adapter = await createTestAdapter();
//   const out = await adapter.handleMessage({ conversationId, from, text, now, metadata });
//   await adapter.echo({ conversationId, text, now });       // una persona escribe desde el número de Forja
//   adapter.command('#pausa 5493415551234');                 // comando de HANDOFF_WHATSAPP
//   await adapter.tick(conversationId, now);                 // seguimiento a esa hora
//   await adapter.alejandro(now);                            // Alejandro escribe o toca "Recibir para reenviar"
//
//   adapter.actions      lo que decidió el core, en orden
//   adapter.aAlejandro   lo que le habría llegado a HANDOFF_WHATSAPP: { via: 'texto' | 'plantilla', texto }
//
// Una sola instancia por proceso (la base es única por proceso).
const crypto = require('crypto');
const db = require('./db');
const core = require('./core');
const repo = require('./repo');
const clock = require('./clock');
const claude = require('./claude');
const tokko = require('./tokko');
const handoff = require('./handoff');
const config = require('../config/forja');
const { buildSystemPrompt } = require('../prompts/forja');

const CREDENCIALES = ['WHATSAPP_TOKEN', 'TOKKO_API_KEY'];

// fixtures: JSON de fichas en formato Tokko (por defecto, el de config).
// llm: reemplazo de src/claude.js ({ chat }); por defecto, Claude real.
async function createTestAdapter({ fixtures, llm } = {}) {
  const presentes = CREDENCIALES.filter((k) => process.env[k]);
  if (presentes.length) throw new Error(`Adapter de test: hay credenciales reales en el entorno (${presentes.join(', ')}). Quitarlas antes de correr.`);

  db.close();
  db.open(':memory:');
  await tokko.sync({ fixtures: fixtures || config.tokko.fixtures });

  const deps = { llm };
  const actions = [];
  const aAlejandro = [];
  // "WhatsApp" de mentira: anota lo que saldría hacia Alejandro.
  const sender = {
    sendMessage: async (_to, texto) => { aAlejandro.push({ via: 'texto', texto }); },
    sendTemplate: async (_to, plantilla, _idioma, params) => { aAlejandro.push({ via: 'plantilla', plantilla, texto: params[1] }); },
  };

  // Registra las acciones y entrega los avisos igual que en producción
  // (texto si Alejandro tiene la ventana abierta; si no, plantilla).
  const registrar = async (conversationId, out, now) => {
    for (const action of out.actions) {
      actions.push({ conversationId, ...action });
      if (action.type === 'notify_handoff') await clock.run(now, () => handoff.entregar(action.payload.derivacionId, sender));
    }
    return out;
  };

  return {
    actions,
    aAlejandro,
    handleMessage: async (input) => registrar(input.conversationId, await core.handleMessage(input, deps), input.now),
    echo: async (input) => core.registerEcho(input, deps),
    command: (text, now) => core.command(text, { now }),
    // Alejandro escribe o toca el botón: recibe en limpio los briefs pendientes. Devuelve cuántos.
    alejandro: (now) => clock.run(now, () => handoff.alEscribirAlejandro(sender)),
    // Si toca el seguimiento, lo da por enviado (como haría WhatsApp) y devuelve el mensaje.
    tick: async (conversationId, now) => {
      const out = await core.tick(conversationId, now, deps);
      for (const a of out.actions) {
        if (a.type === 'send_followup') clock.run(now, () => core.confirmFollowup(a.payload, { ok: true }));
      }
      return registrar(conversationId, { ...out, state: clock.run(now, () => core.buildState(repo.getCurrentLead(conversationId))) }, now);
    },
    // Deja a Alejandro como si nunca hubiera escrito (ventana cerrada) y sin
    // briefs pendientes de entrega. Para aislar un caso de QA del anterior.
    aislar: () => {
      db.get().exec("UPDATE derivaciones SET status = 'enviado' WHERE status != 'enviado'; DELETE FROM estado;");
    },
    // Foto del lead a esa hora (la pausa y el seguimiento dependen del reloj).
    state: (conversationId, now) => clock.run(now, () => core.buildState(repo.getCurrentLead(conversationId))),
    // Lo que quedó registrado del lead (propiedad consultada, seguimiento pedido, pausas...).
    events: (conversationId) => {
      const lead = repo.getCurrentLead(conversationId);
      return lead ? repo.events(lead.id).map((e) => ({ type: e.type, payload: e.payload })) : [];
    },
    // Versión de lo que se está testeando: prompt + herramientas + modelo.
    promptHash: () => crypto.createHash('sha256').update(buildSystemPrompt()).update(JSON.stringify(claude.tools())).update(claude.MODEL).digest('hex').slice(0, 12),
    close: () => db.close(),
  };
}

module.exports = { createTestAdapter };
