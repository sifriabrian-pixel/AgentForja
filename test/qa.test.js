// El arnés de QA (qa/run.js + qa/casos.js) corre contra el Claude real; acá se
// verifica que el arnés funcione, con un LLM guionado que hace lo correcto.
const { scriptedLlm } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestAdapter } = require('../src/test-adapter');
const { correrCaso } = require('../qa/run');
const casos = require('../qa/casos');
const config = require('../config/forja');

const caso = (id) => casos.find((c) => c.id === id);

test('están los 23 casos: 15 de la spec (§11) y 8 que sumó el cliente', () => {
  assert.deepEqual(casos.map((c) => c.id), Array.from({ length: 23 }, (_, i) => i + 1));
});

test('el arnés corre un caso de punta a punta y evalúa sus chequeos', async () => {
  process.env.FOLLOWUP_TEMPLATE_NAME = 'forja_seguimiento';
  const llm = scriptedLlm(
    // Caso 14: pide una persona
    async (h) => { await h.derivar_a_humano({ motivo: 'pide_humano', resumen: 'Quiere hablar con una persona' }); return 'Te paso con un asesor.'; },
    // Caso 15: saludo (después del echo no se vuelve a llamar al LLM)
    'Buenas tardes ¿cómo estás? ¿me dirías tu nombre?',
    // Caso 12: visita, y dos repeticiones que no duplican
    async (h) => { await h.get_property({ referencia: 'venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300' }); return 'Buenas tardes ¿me dirías tu nombre?'; },
    '¿Qué días y horarios te quedan cómodos?',
    async (h) => { await h.derivar_visita({ propiedad_id: '10496295', disponibilidad: 'martes o jueves después de las 17', nombre: 'Carla' }); return config.MSG_VISITA_DERIVADA; },
    async (h) => { await h.derivar_visita({ propiedad_id: '10496295', nombre: 'Carla' }); return 'Tu pedido ya está en manos del asesor.'; },
  );
  const adapter = await createTestAdapter({ llm });
  try {
    for (const id of [14, 15, 12]) {
      const r = await correrCaso(adapter, caso(id));
      assert.equal(r.ok, true, `caso ${id}: ${r.checks.filter((x) => !x.ok).map((x) => x.desc).join('; ')}\n${r.transcripcion.join('\n')}`);
    }
    // Un agente que no deriva tiene que hacer fallar el caso.
    const malo = await createTestAdapter({ llm: scriptedLlm('Claro, compartimos 3 y 3, la comisión es 3%.') });
    const r = await correrCaso(malo, caso(6));
    assert.equal(r.ok, false);
    assert.ok(r.checks.filter((x) => !x.ok).length >= 3, 'no derivó, respondió condiciones y no quedó en pausa');
  } finally {
    adapter.close();
    delete process.env.FOLLOWUP_TEMPLATE_NAME;
  }
});

test('casos 21 a 23: el arnés reproduce la ventana de 24 hs de Alejandro y el toque del botón', async () => {
  process.env.HANDOFF_TEMPLATE_NAME = 'forja_aviso_lead';
  const visitaAyacucho = [
    async (h) => { await h.get_property({ referencia: '10496295' }); return 'Buenas tardes ¿me dirías tu nombre?'; },
    '¿Qué días y horarios te quedan cómodos?',
    async (h) => { await h.derivar_visita({ propiedad_id: '10496295', disponibilidad: 'martes o jueves después de las 17', nombre: 'Carla' }); return config.MSG_VISITA_DERIVADA; },
  ];
  const llm = scriptedLlm(
    ...visitaAyacucho, // caso 21
    ...visitaAyacucho, // caso 22: primera visita...
    async (h) => { await h.get_property({ referencia: '8563856' }); return '¿Los mismos días?'; },
    async (h) => { await h.derivar_visita({ propiedad_id: '8563856', disponibilidad: 'martes o jueves después de las 17', nombre: 'Carla' }); return config.MSG_VISITA_DERIVADA; },
    // caso 23: deriva a humano; en pausa ya no se llama al LLM
    async (h) => { await h.derivar_a_humano({ motivo: 'pide_humano', resumen: 'Quiere hablar con una persona' }); return 'Te paso con un asesor.'; },
  );
  const adapter = await createTestAdapter({ llm });
  try {
    for (const id of [21, 22, 23]) {
      const r = await correrCaso(adapter, caso(id));
      assert.equal(r.ok, true, `caso ${id}: ${r.checks.filter((x) => !x.ok).map((x) => x.desc).join('; ')}\n${r.transcripcion.join('\n')}`);
    }
  } finally {
    adapter.close();
    delete process.env.HANDOFF_TEMPLATE_NAME;
  }
});
