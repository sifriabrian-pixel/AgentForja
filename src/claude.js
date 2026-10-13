// Llamada a Claude con tool calling: una sola llamada por turno (más las
// vueltas del ciclo de herramientas).
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/forja');
const { buildSystemPrompt } = require('../prompts/forja');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'low'; // chat: respuestas cortas, baja latencia
const MAX_VUELTAS = 5;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}
// Para tests: inyectar un cliente falso con la misma forma (beta.messages.create).
function setClient(c) { client = c; }

const NOMBRE = { type: 'string', description: 'Nombre del lead, tal como lo dijo. Omitir si no lo dio.' };

const TOOLS_BASE = [{
  name: 'get_property',
  description: 'Busca una unidad en el catálogo de Forja (Tokko) y devuelve su ficha con el estado de disponibilidad actual. Usala SIEMPRE antes de responder cualquier dato de una unidad. Si devuelve varias candidatas, preguntale al lead cuál es.',
  input_schema: {
    type: 'object',
    properties: {
      referencia: { type: 'string', description: 'Lo que haya para identificarla: id o código de Tokko, link de la web o de un portal, o el texto del anuncio / la dirección que mencionó el lead.' },
    },
    required: ['referencia'],
    additionalProperties: false,
  },
}, {
  name: 'derivar_visita',
  description: 'Le pasa a un asesor el pedido de visita de una unidad. Usala cuando el lead quiere visitar y ya le preguntaste una vez qué días y horarios le quedan cómodos.',
  input_schema: {
    type: 'object',
    properties: {
      propiedad_id: { type: 'string', description: 'id de la unidad, tal como lo devolvió get_property' },
      disponibilidad: { type: 'string', description: 'Días y horarios que dijo el lead. Omitir si no los dio.' },
      nombre: NOMBRE,
    },
    required: ['propiedad_id'],
    additionalProperties: false,
  },
}, {
  name: 'derivar_alquiler_temporario',
  description: 'Le pasa a un asesor una consulta de alquiler temporario (por días o semanas) de una unidad. Usala cuando al lead le interesa y ya te dijo fechas de ingreso y salida y cuántas personas son.',
  input_schema: {
    type: 'object',
    properties: {
      propiedad_id: { type: 'string', description: 'id de la unidad, tal como lo devolvió get_property' },
      fecha_ingreso: { type: 'string', description: 'Tal como la dijo el lead ("10 de noviembre")' },
      fecha_salida: { type: 'string', description: 'Tal como la dijo el lead' },
      personas: { type: 'string', description: 'Cantidad de personas' },
      nombre: NOMBRE,
    },
    required: ['propiedad_id', 'fecha_ingreso', 'fecha_salida', 'personas'],
    additionalProperties: false,
  },
}, {
  name: 'derivar_busqueda',
  description: 'Le pasa al asesor de ventas lo que el lead quiere COMPRAR (incluye comprar para invertir o para renta). No sirve para alquileres. Usala solo cuando tenés tipo, zona y dormitorios: sin eso no deriva. Lo único que puede faltar es el presupuesto.',
  input_schema: {
    type: 'object',
    properties: {
      operacion: { type: 'string', enum: ['venta'], description: 'siempre venta: el lead quiere comprar' },
      tipo: { type: 'string', description: 'departamento, monoambiente, casa, lote, local...' },
      dormitorios: { type: 'string', description: 'Cantidad, tal como la dijo ("2", "2 o 3"). No aplica a monoambientes, lotes ni locales.' },
      zonas: { type: 'string', description: 'Zona o zonas preferidas' },
      excluyentes: { type: 'string', description: 'Requisitos excluyentes en una línea (cochera, orientación, piso, balcón...). Omitir si dijo que no tiene.' },
      presupuesto: { type: 'string', description: 'El monto tal como lo dijo el lead, sin convertir. Omitir si no lo dio o lo esquivó.' },
      moneda: { type: 'string', enum: ['USD', 'ARS'] },
      forma_pago: { type: 'string', description: 'contado, crédito... solo si lo dijo' },
      destino: { type: 'string', description: 'vivienda o inversión (comprar para alquilar o para renta es inversión), solo si surgió' },
      nombre: NOMBRE,
      origen: { type: 'string', description: 'Por dónde llegó: la unidad por la que consultó, el anuncio, o "directo"' },
    },
    required: ['operacion', 'tipo', 'zonas'],
    additionalProperties: false,
  },
}, {
  name: 'derivar_a_humano',
  description: 'Pasa la conversación a una persona de Forja. Usala con colegas inmobiliarios, cuando el lead pide hablar con una persona, ante cualquier consulta que no podés responder (legal, técnica, comisiones, negociación de precio, un dato que no está en la ficha y el lead necesita), y con quien busca alquilar sin una unidad puntual (motivo "alquiler", después de preguntarle zona y fechas).',
  input_schema: {
    type: 'object',
    properties: {
      motivo: { type: 'string', enum: ['colega', 'consulta_sin_respuesta', 'pide_humano', 'alquiler'] },
      resumen: { type: 'string', description: 'La consulta en una línea, para que el asesor entienda sin abrir el chat. Con motivo "alquiler": qué busca, zona y fechas.' },
      nombre: NOMBRE,
    },
    required: ['motivo', 'resumen'],
    additionalProperties: false,
  },
}, {
  name: 'programar_seguimiento',
  description: 'Agenda un único mensaje de seguimiento para más adelante. Usala cuando el lead declina la unidad y no quiere que le busquen otra cosa por ahora.',
  input_schema: {
    type: 'object',
    properties: { motivo: { type: 'string', description: 'Por qué no avanzó, en pocas palabras' } },
    additionalProperties: false,
  },
}, {
  name: 'cancelar_seguimiento',
  description: 'Usala si el lead pide que no lo vuelvan a contactar.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
}];

const TOOL_BUSQUEDA = {
  name: 'search_properties',
  description: 'Busca unidades disponibles en la cartera de Forja por filtros.',
  input_schema: {
    type: 'object',
    properties: {
      operacion: { type: 'string', enum: ['venta', 'alquiler'] },
      tipo: { type: 'string' },
      zona: { type: 'string' },
      dormitorios_min: { type: 'integer' },
      precio_max: { type: 'number' },
      moneda: { type: 'string', enum: ['USD', 'ARS'] },
    },
    additionalProperties: false,
  },
};

// En v1 el agente no ofrece opciones de la cartera: search_properties solo
// existe si ENABLE_PROPERTY_SEARCH=true.
function tools() {
  return config.ENABLE_PROPERTY_SEARCH ? [...TOOLS_BASE, TOOL_BUSQUEDA] : TOOLS_BASE;
}

// contexto: texto del turno (hora, origen, datos ya conocidos). Va en un bloque
// de system aparte, sin cache, porque cambia en cada llamada.
// handlers: { nombre_de_tool(input) } → string (o promesa) con el resultado que se le devuelve a Claude.
async function chat(historial, contexto, handlers) {
  const system = [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }];
  if (contexto) system.push({ type: 'text', text: contexto });

  const messages = [...historial];
  const textos = [];
  let stopReason = null;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      tools: tools(),
      messages,
    });
    stopReason = response.stop_reason;
    if (stopReason === 'refusal') break;

    // Se queda con el texto de la última vuelta que escribió algo: si Claude
    // escribe, llama a una herramienta y vuelve a escribir, la respuesta final es la última.
    const textoVuelta = response.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
    if (textoVuelta.length) textos.splice(0, textos.length, ...textoVuelta);

    if (stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const usos = response.content.filter((b) => b.type === 'tool_use');
    if (stopReason !== 'tool_use' || usos.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const resultados = [];
    for (const uso of usos) {
      let contenido;
      let esError = false;
      const handler = handlers[uso.name];
      try {
        contenido = handler ? await handler(uso.input || {}) : `Herramienta desconocida: ${uso.name}`;
        esError = !handler;
      } catch (e) {
        contenido = `Error en ${uso.name}: ${e.message}`;
        esError = true;
      }
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: contenido, is_error: esError });
    }
    messages.push({ role: 'user', content: resultados });
  }

  return { texto: textos.join('\n\n'), stopReason };
}

module.exports = { chat, setClient, tools, MODEL };
