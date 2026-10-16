const { HANDOFF, P, T0, masHoras, freshDb, scriptedLlm } = require('./helpers');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const repo = require('../src/repo');
const claude = require('../src/claude');
const config = require('../config/forja');

const WA = '5493415551234';
let n = 0;
const msg = (text, extra = {}) => ({ conversationId: WA, from: WA, text, now: T0, messageId: `m.${n += 1}`, ...extra });

beforeEach(() => freshDb());
afterEach(() => {
  delete process.env.ENABLE_PROPERTY_SEARCH;
  delete process.env.TOKKO_API_KEY;
});

test('visita: get_property identifica la unidad y derivar_visita deja el brief para Alejandro', async () => {
  const llm = scriptedLlm(
    async (h) => {
      const ficha = JSON.parse(await h.get_property({ referencia: 'https://www.forjapropiedades.com/propiedades/venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300' }));
      assert.equal(ficha.id, P.ayacucho);
      assert.equal(ficha.estado, 'disponible');
      return 'Buenas tardes ¿cómo estás? Sí, está disponible. ¿Me dirías tu nombre?';
    },
    '¿Qué días y horarios te quedan cómodos?',
    async (h) => {
      const r = await h.derivar_visita({ propiedad_id: P.ayacucho, disponibilidad: 'martes por la tarde', nombre: 'Lucía' });
      assert.match(r, /Visita derivada/);
      assert.ok(r.includes(config.MSG_VISITA_DERIVADA), 'la herramienta le dicta la frase de Alejandro');
      return config.MSG_VISITA_DERIVADA;
    },
  );
  const o1 = await core.handleMessage(msg('Hola, vi este depto https://www.forjapropiedades.com/propiedades/venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300'), { llm });
  assert.equal(o1.state.propiedadId, P.ayacucho);
  assert.deepEqual(o1.actions, []);
  await core.handleMessage(msg('Soy Lucía, me gustaría visitarlo'), { llm });
  const o3 = await core.handleMessage(msg('martes por la tarde'), { llm });

  assert.equal(o3.actions.length, 1);
  assert.equal(o3.actions[0].type, 'notify_handoff');
  assert.equal(o3.actions[0].payload.texto,
    `(VISITA VENTA) Piso exclusivo de 3 dormitorios - Ayacucho 1300 - Cód. Tokko FAP${P.ayacucho} / ${P.ayacucho} - https://www.forjapropiedades.com/propiedades/venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300 - Disponibilidad: martes por la tarde - Lucía - +${WA}`);
  assert.equal(o3.state.derived, true);
  assert.equal(o3.state.paused, false, 'una visita no pausa al agente');
  assert.equal(repo.derivacionesDe(o3.state.leadId)[0].destino, HANDOFF);
});

test('el lead repite "quiero visitar" después de derivado: no se duplica la derivación', async () => {
  const derivar = async (h) => h.derivar_visita({ propiedad_id: P.ayacucho, nombre: 'Lucía' });
  let segunda;
  const llm = scriptedLlm(
    async (h) => { await derivar(h); return config.MSG_VISITA_DERIVADA; },
    async (h) => { segunda = await derivar(h); return 'Tu pedido ya está en manos del asesor.'; },
  );
  const o1 = await core.handleMessage(msg('quiero visitar el de Ayacucho'), { llm });
  const o2 = await core.handleMessage(msg('quiero visitar'), { llm });
  assert.equal(o1.actions.length, 1);
  assert.deepEqual(o2.actions, [], 'no hay un segundo aviso');
  assert.match(segunda, /ya estaba derivado/);
  assert.equal(o2.state.derivaciones.length, 1);
  assert.match(llm.llamadas[1].contexto, /Ya derivado a un asesor: visita/);
});

test('unidad reservada: get_property avisa y derivar_visita no deriva', async () => {
  let ficha;
  let intento;
  const llm = scriptedLlm(async (h) => {
    ficha = JSON.parse(await h.get_property({ referencia: P.reservada }));
    intento = await h.derivar_visita({ propiedad_id: P.reservada });
    return 'Esa unidad está reservada. ¿Qué estás buscando?';
  });
  const out = await core.handleMessage(msg('me interesa la casa de Funes Hills'), { llm });
  assert.equal(ficha.estado, 'reservada');
  assert.match(ficha.instruccion, /NO está disponible/);
  assert.match(intento, /No se derivó: la unidad figura como reservada/);
  assert.deepEqual(out.actions, []);
  assert.equal(out.state.derived, false);
});

test('derivar_visita vuelve a consultar Tokko: si se reservó recién, no deriva', async () => {
  process.env.TOKKO_API_KEY = 'clave-de-prueba';
  const fetchReal = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: Number(P.kentucky), status: 3, fake_address: 'Casa en Barrio Kentucky Club de Campo', operations: [{ operation_type: 'Venta', prices: [{ currency: 'USD', price: 980000 }] }] }) });
  try {
    let r;
    const llm = scriptedLlm(async (h) => { r = await h.derivar_visita({ propiedad_id: P.kentucky }); return 'ok'; });
    const out = await core.handleMessage(msg('quiero visitarla'), { llm });
    assert.match(r, /figura como reservada/);
    assert.deepEqual(out.actions, []);
  } finally {
    global.fetch = fetchReal;
  }
});

test('búsqueda: no deriva hasta tener zona y dormitorios; "a confirmar" solo vale para el presupuesto', async () => {
  const intentos = [];
  const llm = scriptedLlm(
    async (h) => { await h.get_property({ referencia: P.kentucky }); return 'Es una casa de USD 980.000.'; },
    async (h) => {
      intentos.push(await h.derivar_busqueda({ operacion: 'venta', tipo: 'casa', dormitorios: '3', nombre: 'Marcos' }));
      intentos.push(await h.derivar_busqueda({ operacion: 'venta', tipo: 'casa', dormitorios: '3', zonas: 'a confirmar', nombre: 'Marcos' }));
      return '¿En qué zona o zonas te gustaría?';
    },
    async (h) => {
      const r = await h.derivar_busqueda({ operacion: 'venta', tipo: 'casa', dormitorios: '3', zonas: 'Funes o Fisherton', excluyentes: 'pileta', nombre: 'Marcos' });
      assert.ok(r.includes(config.MSG_BUSQUEDA_DERIVADA), 'la herramienta le dicta el texto del cliente');
      return config.MSG_BUSQUEDA_DERIVADA;
    },
  );
  await core.handleMessage(msg('info de la casa de Kentucky'), { llm });
  const o2 = await core.handleMessage(msg('se me va de presupuesto, busco casa de 3 dormitorios'), { llm });
  assert.match(intentos[0], /No se derivó\. Faltan: zonas/);
  assert.match(intentos[1], /No se derivó\. Faltan: zonas/, 'una zona "a confirmar" no alcanza');
  assert.deepEqual(o2.actions, []);
  assert.equal(o2.state.derived, false);

  const o3 = await core.handleMessage(msg('Funes o Fisherton, con pileta'), { llm });
  assert.equal(o3.actions.length, 1);
  // El brief va limpio, listo para reenviar; el origen viaja aparte.
  assert.equal(o3.actions[0].payload.texto, `(BÚSQUEDA VENTA) casa, 3 dormitorios - Requisitos: pileta - Zona: Funes o Fisherton - Presupuesto: a confirmar - Marcos - +${WA}`);
  assert.equal(o3.actions[0].payload.nota, `Origen: consultó por Casa en Barrio Kentucky Club de Campo (cód. Tokko ${P.kentucky})`);
  assert.equal(o3.state.datos.busqueda.zonas, 'Funes o Fisherton');
  assert.deepEqual(o3.messages, ['Perfecto, vamos a derivar la búsqueda al asesor de ventas para que te contacte y evalúen opciones']);
});

test('búsqueda directa desde un anuncio: compra para invertir, el origen sale del referral', async () => {
  const llm = scriptedLlm(async (h) => {
    await h.derivar_busqueda({ operacion: 'venta', tipo: 'monoambiente', zonas: 'cerca de facultades', destino: 'inversión', presupuesto: '40 mil', moneda: 'USD', nombre: 'Maria Angélica' });
    return 'listo';
  });
  const out = await core.handleMessage(msg('busco monoambiente cerca de facultades para invertir, 40 mil', {
    metadata: { referral: { source_id: 'ad-1', source_type: 'ad', headline: 'Invertí en Rosario' }, profileName: 'Mari' },
  }), { llm });
  assert.equal(out.actions[0].payload.texto,
    `(BÚSQUEDA VENTA) monoambiente - Requisitos: sin excluyentes - Zona: cerca de facultades, es para inversión - Presupuesto: u$s 40 mil - Maria Angélica - +${WA}`);
  assert.equal(out.actions[0].payload.nota, 'Origen: anuncio "Invertí en Rosario"');
  assert.equal(out.state.source, 'ctwa');
  assert.match(llm.llamadas[0].contexto, /Llegó desde un anuncio de Meta\. Texto del anuncio: "Invertí en Rosario"/);
});

test('no hay búsquedas de alquiler: derivar_busqueda las rechaza y el camino es derivar_a_humano (alquiler)', async () => {
  let rechazo;
  const llm = scriptedLlm(
    async (h) => { rechazo = await h.derivar_busqueda({ operacion: 'alquiler', tipo: 'casa', dormitorios: '3', zonas: 'Funes' }); return '¿Para qué fechas lo necesitarías?'; },
    async (h) => { await h.derivar_a_humano({ motivo: 'alquiler', resumen: 'Busca alquilar casa de 3 dormitorios en Funes desde marzo', nombre: 'Vero' }); return 'Te va a contactar un asesor.'; },
  );
  const o1 = await core.handleMessage(msg('busco alquilar una casa de 3 dormitorios en Funes'), { llm });
  assert.match(rechazo, /Forja no hace búsquedas de alquiler/);
  assert.deepEqual(o1.actions, []);
  const o2 = await core.handleMessage(msg('desde marzo, soy Vero'), { llm });
  assert.equal(o2.actions[0].payload.texto, `(ATENCIÓN HUMANA - alquiler) Busca alquilar casa de 3 dormitorios en Funes desde marzo - Vero - +${WA}`);
  assert.equal(o2.actions[0].payload.nota, null);
  assert.equal(o2.state.derivaciones.some((d) => d.tipo === 'busqueda'), false, 'no se arma brief de búsqueda');
  assert.equal(o2.state.paused, true);
});

test('alquiler temporario: pide fechas y personas, y arma el brief nuevo', async () => {
  const pasos = [];
  const llm = scriptedLlm(
    async (h) => {
      const ficha = JSON.parse(await h.get_property({ referencia: P.temporario }));
      assert.equal(ficha.operacion, 'Alquiler temporario');
      assert.equal(ficha.precio, 'USD 2.000', 'un temporario no se muestra "por mes"');
      pasos.push(await h.derivar_alquiler_temporario({ propiedad_id: P.temporario, fecha_ingreso: '10 de noviembre' }));
      return '¿Hasta qué fecha te quedarías y cuántas personas son?';
    },
    async (h) => {
      pasos.push(await h.derivar_alquiler_temporario({ propiedad_id: P.temporario, fecha_ingreso: '10 de noviembre', fecha_salida: '17 de noviembre', personas: '4', nombre: 'Sofía' }));
      return config.MSG_TEMPORARIO_DERIVADO;
    },
    async (h) => { pasos.push(await h.derivar_alquiler_temporario({ propiedad_id: P.temporario, fecha_ingreso: '10 de noviembre', fecha_salida: '17 de noviembre', personas: '4' })); return 'El asesor ya tiene tu consulta.'; },
  );
  const o1 = await core.handleMessage(msg('quiero el depto de Puerto Madero por una semana desde el 10 de noviembre'), { llm });
  assert.match(pasos[0], /No se derivó\. Faltan: fecha_salida, personas/);
  assert.deepEqual(o1.actions, []);

  const o2 = await core.handleMessage(msg('hasta el 17, somos 4. Soy Sofía'), { llm });
  assert.match(pasos[1], /No confirmes que esas fechas están libres/);
  assert.equal(o2.actions[0].payload.tipo, 'temporario');
  assert.equal(o2.actions[0].payload.texto,
    `(ALQUILER TEMPORARIO) Departamento de 2 dormitorios - Juana Manso 400, Puerto Madero - Cód. Tokko FAP${P.temporario} / ${P.temporario} - Fechas: 10 de noviembre al 17 de noviembre - Personas: 4 - Sofía - +${WA}`);
  assert.equal(o2.state.paused, false);

  const o3 = await core.handleMessage(msg('¿me confirmás?'), { llm });
  assert.match(pasos[2], /ya estaba derivada/);
  assert.deepEqual(o3.actions, [], 'repetir el pedido no duplica el brief');
});

test('derivar_a_humano (colega): avisa, pausa el agente y ese chat no recibe más respuestas', async () => {
  const llm = scriptedLlm(async (h) => {
    await h.derivar_a_humano({ motivo: 'colega', resumen: 'De Inmobiliaria X, pregunta si comparten 3 y 3' });
    return 'Gracias por escribir, te paso con un asesor que te responde eso.';
  }, 'NO DEBERÍA RESPONDER');
  const o1 = await core.handleMessage(msg('Hola, soy de Inmobiliaria X, ¿comparten 3 y 3?', { metadata: { profileName: 'Juan Corredor' } }), { llm });
  assert.equal(o1.messages.length, 1);
  assert.equal(o1.actions[0].payload.texto, `(ATENCIÓN HUMANA - colega) De Inmobiliaria X, pregunta si comparten 3 y 3 - Juan Corredor - +${WA}`);
  assert.equal(o1.state.paused, true);
  assert.equal(o1.state.datos.colega, true);
  assert.equal(o1.state.followup, null, 'a un colega no se le hace seguimiento');

  const o2 = await core.handleMessage(msg('¿y la comisión?', { now: masHoras(T0, 1) }), { llm });
  assert.deepEqual(o2.messages, []);
  assert.equal(llm.llamadas.length, 1, 'en pausa ni siquiera se llama a Claude');
  assert.equal(repo.history(WA).filter((m) => m.direction === 'in').length, 2, 'el mensaje queda en el historial');

  // Pasadas las HUMAN_TAKEOVER_HOURS (24) el agente vuelve a responder, sin volver a derivar por lo mismo.
  const o3 = await core.handleMessage(msg('hola?', { now: masHoras(T0, 25) }), { llm });
  assert.equal(o3.messages.length, 1);
  assert.equal(o3.state.derivaciones.length, 1);
});

test('contexto: saludo según la hora de Argentina y primer mensaje', async () => {
  const llm = scriptedLlm('Buenas noches ¿cómo estás? ¿me dirías tu nombre?', 'ok');
  await core.handleMessage(msg('hola', { now: '2026-10-13T02:00:00.000Z' }), { llm }); // 23:00 en Argentina
  assert.match(llm.llamadas[0].contexto, /Saludo que corresponde ahora: "Buenas noches"/);
  assert.match(llm.llamadas[0].contexto, /Es tu primer mensaje/);
  await core.handleMessage(msg('Pedro', { now: '2026-10-13T12:30:00.000Z' }), { llm }); // 09:30
  assert.match(llm.llamadas[1].contexto, /"Buenos días"/);
  assert.match(llm.llamadas[1].contexto, /Ya saludaste/);
});

test('contexto: una vez que el agente preguntó el presupuesto, se le prohíbe volver a preguntarlo', async () => {
  const llm = scriptedLlm('¿En qué zona te gustaría?', '¿Tenés un presupuesto aproximado? ¿Sería contado o con crédito?', 'ok');
  await core.handleMessage(msg('busco depto'), { llm });
  await core.handleMessage(msg('Fisherton'), { llm });
  assert.doesNotMatch(llm.llamadas[1].contexto, /Presupuesto: YA lo preguntaste/);
  await core.handleMessage(msg('depende de lo que haya'), { llm });
  assert.match(llm.llamadas[2].contexto, /Presupuesto: YA lo preguntaste una vez\. No lo vuelvas a preguntar/);
});

test('contexto: la ficha de la unidad consultada viaja en cada turno, sin datos inventados', async () => {
  const llm = scriptedLlm(async (h) => { await h.get_property({ referencia: P.ayacucho }); return 'ok'; }, 'ok');
  await core.handleMessage(msg('info del de Ayacucho 1300'), { llm });
  await core.handleMessage(msg('¿cuánto paga de expensas?'), { llm });
  const ctx = llm.llamadas[1].contexto;
  assert.match(ctx, /"precio":"USD 300\.000"/);
  assert.match(ctx, /"sin_dato":\[[^\]]*"expensas"/, 'las expensas no están en Tokko: el agente lo ve como dato faltante');
});

test('si Claude deriva pero no escribe nada, el lead recibe igual la frase de derivación', async () => {
  const llm = scriptedLlm(async (h) => { await h.derivar_visita({ propiedad_id: P.aurea }); return ''; });
  const out = await core.handleMessage(msg('quiero verlo'), { llm });
  assert.deepEqual(out.messages, [config.MSG_VISITA_DERIVADA]);
});

test('echo: cuando una persona escribe desde el número de Forja, el agente se pausa 24 hs en ese chat', async () => {
  const llm = scriptedLlm('Buenas tardes ¿me dirías tu nombre?', 'respuesta después de la pausa');
  await core.handleMessage(msg('hola'), { llm });

  const eco = core.registerEcho({ conversationId: WA, messageId: 'wamid.echo.1', text: 'Hola, soy Alejandro, te llamo en un rato', now: masHoras(T0, 1) });
  assert.equal(eco.pausado, true);
  assert.equal(core.registerEcho({ conversationId: WA, messageId: 'wamid.echo.1', text: 'repetido', now: masHoras(T0, 1) }).pausado, false, 'el mismo echo dos veces no cuenta');

  const o2 = await core.handleMessage(msg('dale, gracias', { now: masHoras(T0, 2) }), { llm });
  assert.deepEqual(o2.messages, []);
  assert.equal(o2.state.paused, true);

  const o3 = await core.handleMessage(msg('seguís ahí?', { now: masHoras(T0, 26) }), { llm });
  assert.equal(o3.messages[0], 'respuesta después de la pausa');
  const historial = llm.llamadas[1].historial.map((m) => m.content).join('\n');
  assert.match(historial, /\[Mensaje escrito por una persona del equipo de Forja\] Hola, soy Alejandro/, 'el agente ve lo que escribió la persona');
  assert.match(historial, /dale, gracias/);
});

test('un mensaje del propio agente que vuelve como echo no lo pausa', async () => {
  const llm = scriptedLlm('hola');
  const o1 = await core.handleMessage(msg('hola'), { llm });
  repo.markOutbound(o1.meta.outboundId, 'enviado', 'wamid.del.agente');
  assert.equal(core.registerEcho({ conversationId: WA, messageId: 'wamid.del.agente', text: 'hola', now: T0 }).pausado, false);
  assert.equal(repo.isPaused(repo.getCurrentLead(WA)), false);
});

test('comandos #pausa y #reanudar', async () => {
  const llm = scriptedLlm('hola', 'volví');
  await core.handleMessage(msg('hola'), { llm });

  assert.deepEqual(core.command('hola, ¿cómo va?'), { esComando: false, reply: null });
  assert.match(core.command('#pausa').reply, /Falta el número/);
  assert.match(core.command('#pausa 5491100000000').reply, /No encontré una conversación/);

  // Alejandro tipea el número como lo ve en su teléfono, con espacios y sin el 9.
  const pausa = core.command('#pausa +54 341 555-1234', { now: T0 });
  assert.match(pausa.reply, /no responde más a \+5493415551234/);
  const o2 = await core.handleMessage(msg('hola?', { now: masHoras(T0, 24 * 30) }), { llm });
  assert.deepEqual(o2.messages, [], 'la pausa manual no vence sola');

  // Un echo no acorta una pausa manual.
  core.registerEcho({ conversationId: WA, messageId: 'e9', text: 'x', now: masHoras(T0, 24 * 30) });
  assert.equal(repo.getCurrentLead(WA).pause_reason, 'comando');

  assert.match(core.command('#REANUDAR 3415551234', { now: masHoras(T0, 24 * 31) }).reply, /vuelve a responder/);
  const o3 = await core.handleMessage(msg('hola', { now: masHoras(T0, 24 * 31) }), { llm });
  assert.deepEqual(o3.messages, ['volví']);
});

test('search_properties solo existe con ENABLE_PROPERTY_SEARCH=true', () => {
  const nombres = () => claude.tools().map((t) => t.name);
  assert.deepEqual(nombres(), ['get_property', 'derivar_visita', 'derivar_alquiler_temporario', 'derivar_busqueda', 'derivar_a_humano', 'programar_seguimiento', 'cancelar_seguimiento']);
  process.env.ENABLE_PROPERTY_SEARCH = 'true';
  assert.ok(nombres().includes('search_properties'));
});

test('el prompt lleva las reglas del cliente: mascotas, texto de búsqueda, comprar o alquilar', () => {
  const prompt = require('../prompts/forja').buildSystemPrompt();
  assert.ok(prompt.includes('"En principio sí, te lo confirma el asesor"'));
  assert.ok(prompt.includes('"Perfecto, vamos a derivar la búsqueda al asesor de ventas para que te contacte y evalúen opciones"'));
  assert.match(prompt, /¿Estás buscando para comprar o para alquilar\?/);
  assert.match(prompt, /Forja no hace búsquedas de alquiler/);
  assert.doesNotMatch(prompt, /\{nombre\}|undefined/);
});

test('mensajes que entran mientras Claude responde: se contesta todo junto y la derivación no se pierde', async () => {
  let llamadas = 0;
  const llm = {
    chat: async (_h, _c, h) => {
      llamadas += 1;
      if (llamadas === 1) {
        await h.derivar_visita({ propiedad_id: P.ayacucho, nombre: 'Lu' });
        core.ingest(msg('ah, y puedo los jueves'));
      }
      return { texto: `respuesta ${llamadas}`, stopReason: 'end_turn' };
    },
  };
  const out = await core.handleMessage(msg('quiero visitar el de Ayacucho'), { llm });
  assert.deepEqual(out.messages, ['respuesta 2']);
  assert.equal(out.actions.length, 1, 'el aviso creado en la primera vuelta sale igual');
  assert.equal(repo.pendingInbound(WA).length, 0);
});

test('el prompt pide presentar la unidad con diferenciales y seguir con destino, plazo y recién después la visita', () => {
  const prompt = require('../prompts/forja').buildSystemPrompt();
  assert.match(prompt, /SIEMPRE empieza con el saludo/);
  assert.match(prompt, /En la primera respuesta NO ofrezcas visita/);
  const orden = ['¿La buscás para vivir o como inversión?', '¿En qué plazo estás analizando hacer la compra? ¿Lo antes posible, 3 meses, 6?', 'Perfecto ¿Alguna duda o te parece si coordinamos una visita con uno de nuestros vendedores?'].map((t) => prompt.indexOf(t));
  assert.ok(orden.every((i) => i > 0) && orden[0] < orden[1] && orden[1] < orden[2], 'las tres preguntas están, en ese orden');
});
