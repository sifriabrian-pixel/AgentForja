// Corre los 23 casos de QA (qa/casos.js) contra el Claude real, usando el adapter
// de test: base en memoria, catálogo de fixtures, nada sale por WhatsApp.
//
//   npm run qa              todos los casos
//   npm run qa -- 3 12      solo esos casos
//
// Necesita ANTHROPIC_API_KEY en .env. Deja el detalle en qa/resultados/.
require('dotenv').config({ quiet: true });
// El adapter de test no corre con credenciales reales de WhatsApp o Tokko cargadas.
for (const k of ['WHATSAPP_TOKEN', 'TOKKO_API_KEY']) delete process.env[k];
process.env.FOLLOWUP_TEMPLATE_NAME = process.env.FOLLOWUP_TEMPLATE_NAME || 'forja_seguimiento';
process.env.HANDOFF_WHATSAPP = process.env.HANDOFF_WHATSAPP || '5493410000000';
process.env.HANDOFF_TEMPLATE_NAME = process.env.HANDOFF_TEMPLATE_NAME || 'forja_aviso_lead';

const fs = require('fs');
const path = require('path');
const { createTestAdapter } = require('../src/test-adapter');
const casos = require('./casos');

// Lunes 12 de octubre de 2026, 15:00 en Argentina.
const INICIO = '2026-10-12T18:00:00.000Z';
const MINUTO = 60 * 1000;

async function correrCaso(adapter, caso) {
  const conversationId = `54934155${String(1000 + caso.id)}`;
  let ahora = new Date(INICIO).getTime();
  const respuestas = [];
  const briefsAlPaso = [];
  const recibidosAlPaso = [];
  const transcripcion = [];
  // Cada caso arranca con Alejandro sin haber escrito (ventana de 24 hs cerrada)
  // y sin briefs pendientes de casos anteriores.
  adapter.aislar();
  const desde = adapter.aAlejandro.length;
  const recibidos = () => adapter.aAlejandro.slice(desde);
  let vistos = 0;
  const anotarRecibidos = () => {
    for (const m of recibidos().slice(vistos)) transcripcion.push(`→ A ALEJANDRO (${m.via}): ${m.texto}`);
    vistos = recibidos().length;
  };

  for (const paso of caso.pasos) {
    ahora += MINUTO;
    const now = new Date(ahora).toISOString();
    let out = null;
    if (paso.hora) {
      ahora = new Date(paso.hora).getTime();
    } else if (paso.lead) {
      transcripcion.push(`LEAD: ${paso.lead}`);
      out = await adapter.handleMessage({ conversationId, from: conversationId, text: paso.lead, now, metadata: paso.metadata });
    } else if (paso.echo) {
      transcripcion.push(`ALEJANDRO (a mano): ${paso.echo}`);
      await adapter.echo({ conversationId, text: paso.echo, now });
    } else if (paso.alejandro) {
      transcripcion.push(`ALEJANDRO: ${paso.alejandro}`);
      await adapter.alejandro(now);
    } else if (paso.dias) {
      ahora += paso.dias * 24 * 60 * MINUTO;
      transcripcion.push(`— pasan ${paso.dias} días —`);
      out = await adapter.tick(conversationId, new Date(ahora).toISOString());
    }
    const texto = out?.messages?.join('\n') || '';
    respuestas.push(texto);
    briefsAlPaso.push(adapter.actions.filter((a) => a.conversationId === conversationId && a.type === 'notify_handoff').length);
    if (texto) transcripcion.push(`AGENTE: ${texto}`);
    else if (paso.lead) transcripcion.push('AGENTE: (sin respuesta)');
    anotarRecibidos();
    recibidosAlPaso.push(recibidos().length);
  }

  const acciones = adapter.actions.filter((a) => a.conversationId === conversationId);
  const ctx = {
    respuestas,
    briefsAlPaso,
    todas: respuestas.filter(Boolean),
    acciones,
    briefs: (tipo) => acciones.filter((a) => a.type === 'notify_handoff' && a.payload.tipo === tipo).map((a) => a.payload.texto),
    aAlejandro: recibidos(),
    recibidosAlPaso,
    state: adapter.state(conversationId, new Date(ahora).toISOString()),
    eventos: adapter.events(conversationId),
  };
  const checks = caso.checks(ctx);
  return { id: caso.id, nombre: caso.nombre, ok: checks.every((x) => x.ok), checks, transcripcion };
}

async function main({ llm } = {}) {
  if (!llm && !process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY en .env: el QA corre contra el Claude real.');
    process.exit(2);
  }
  const pedidos = process.argv.slice(2).map(Number).filter(Boolean);
  const elegidos = pedidos.length ? casos.filter((c) => pedidos.includes(c.id)) : casos;

  const adapter = await createTestAdapter({ llm });
  console.log(`QA Forja — ${elegidos.length} caso(s) — versión del agente ${adapter.promptHash()}\n`);

  const resultados = [];
  for (const caso of elegidos) {
    let r;
    try {
      r = await correrCaso(adapter, caso);
    } catch (e) {
      r = { id: caso.id, nombre: caso.nombre, ok: false, checks: [{ ok: false, desc: `error al correr: ${e.message}` }], transcripcion: [] };
    }
    resultados.push(r);
    console.log(`${r.ok ? '✅' : '❌'} ${String(r.id).padStart(2)}. ${r.nombre}`);
    for (const x of r.checks) if (!x.ok) console.log(`      ✗ ${x.desc}`);
    if (!r.ok) console.log(r.transcripcion.map((l) => `      | ${l}`).join('\n'));
  }
  adapter.close();

  const pasaron = resultados.filter((r) => r.ok).length;
  console.log(`\n${pasaron} de ${resultados.length} casos pasan.`);

  const dir = path.join(__dirname, 'resultados');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `qa-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(archivo, JSON.stringify({ version: adapter.promptHash(), pasaron, total: resultados.length, resultados }, null, 2));
  console.log(`Detalle: ${path.relative(process.cwd(), archivo)}`);
  return resultados;
}

if (require.main === module) {
  main().then((r) => process.exit(r.every((x) => x.ok) ? 0 : 1)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, correrCaso };
