// Configuración de Forja Propiedades.
// Todo lo específico del cliente vive acá. Los valores marcados [DEFAULT] son
// supuestos de la spec a confirmar con Forja: se cambian acá o por variable
// de entorno, sin tocar la lógica.

const env = (k, def) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : def);
const num = (k, def) => {
  const n = Number(env(k, def));
  return Number.isFinite(n) && n > 0 ? n : def;
};

module.exports = {
  cliente: 'Forja Propiedades',
  web: 'https://www.forjapropiedades.com',

  // Links a la web ya filtrados (la página de propiedades lee ?operation= y &city=).
  linksWeb: {
    alquiler: 'https://www.forjapropiedades.com/propiedades?operation=Alquiler',
    alquilerPorCiudad: { Rosario: 'Rosario', 'Buenos Aires': 'Capital%20Federal', Funes: 'Funes' },
  },

  // [DEFAULT] Cómo se presenta el agente.
  get AGENT_IDENTITY() { return env('AGENT_IDENTITY', 'el asistente de Forja Propiedades'); },
  TIMEZONE: 'America/Argentina/Buenos_Aires',

  // Todas las derivaciones van a este número (hoy, Alejandro).
  get HANDOFF_WHATSAPP() { return env('HANDOFF_WHATSAPP', ''); },
  // Plantilla (utility, con botón "Recibir para reenviar") para cuando Alejandro
  // tiene cerrada la ventana de 24 hs. Texto para aprobar en docs/plantillas-meta.md.
  get HANDOFF_TEMPLATE_NAME() { return env('HANDOFF_TEMPLATE_NAME', ''); },
  handoff: { idioma: 'es_AR' },
  // Aviso cuando un lead en pausa vuelve a escribir y ninguna persona le respondió.
  MSG_AVISO_PAUSA: 'El lead {nombre} ({telefono}) volvió a escribir: "{mensaje}"',

  // Seguimiento: cuándo sale cada toque, contado desde la última respuesta del
  // agente (por ejemplo, la ficha que el lead no contestó). Hoy es uno solo, al
  // día siguiente: a las 23 h, todavía dentro de la ventana de 24 hs de WhatsApp,
  // así sale como mensaje común, sin plantilla ni costo (pedido de Brian, 2026-10-21).
  // FOLLOWUP_HOURS=23 (por defecto) o FOLLOWUP_DAYS=1,5 para varios toques en días;
  // FOLLOWUP_DAYS, si está, manda. Devuelve siempre días.
  get FOLLOWUP_DAYS() {
    const lista = (v) => String(v).replace(/[^\d.,]/g, '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    const dias = env('FOLLOWUP_DAYS', '') ? lista(env('FOLLOWUP_DAYS', '')) : lista(env('FOLLOWUP_HOURS', '23')).map((h) => h / 24);
    return dias.length ? dias : [23 / 24];
  },
  get FOLLOWUP_TEMPLATE_NAME() { return env('FOLLOWUP_TEMPLATE_NAME', ''); },
  seguimiento: {
    // Solo se envía dentro de esta franja (hora de Argentina).
    franja: { desde: 9, hasta: 20 },
    // Si pasaron más de estos días desde que tocaba y no se pudo enviar, se cancela.
    vencimientoDias: 2,
    // true si la plantilla aprobada lleva el saludo ("Buenas tardes") como {{1}}.
    plantillaConSaludo: false,
    idioma: 'es_AR',
  },
  // Dentro de la ventana de 24 hs (texto libre, con el saludo según la hora):
  MSG_SEGUIMIENTO: '{saludo} ¿cómo estás? Te saluda {identidad} ¿tenés alguna búsqueda activa en la que podamos ayudarte?',
  // [DEFAULT] Si lo último que recibió fue la ficha de una unidad, el seguimiento la retoma.
  MSG_SEGUIMIENTO_FICHA: '{saludo} ¿cómo estás? Te saluda {identidad}. ¿Pudiste ver la ficha que te pasé? Si te interesa, coordinamos una visita; y si no es lo que buscás, contame qué estás buscando y te ayudo.',
  // Fuera de la ventana sale la plantilla aprobada. Tiene que decir lo mismo que
  // la plantilla cargada en Meta (docs/plantillas-meta.md): es lo que queda en el historial.
  MSG_SEGUIMIENTO_PLANTILLA: 'Hola ¿cómo estás? Te saluda {identidad} ¿tenés alguna búsqueda activa en la que podamos ayudarte?',

  // [DEFAULT] Horas que el agente queda callado cuando interviene una persona.
  get HUMAN_TAKEOVER_HOURS() { return num('HUMAN_TAKEOVER_HOURS', 24); },
  comandos: { pausa: '#pausa', reanudar: '#reanudar' },

  // Fase 2: ofrecerle al lead opciones de la cartera. En v1 la búsqueda la hace el asesor.
  get ENABLE_PROPERTY_SEARCH() { return env('ENABLE_PROPERTY_SEARCH', 'false') === 'true'; },

  // Frases al derivar. Visita: de Alejandro (§4.6). Búsqueda: texto del cliente.
  // Temporario y mascotas: [DEFAULT] a confirmar con Forja.
  MSG_VISITA_DERIVADA: 'Perfecto, tu pedido de visita fue derivado, te va a contactar el encargado de comercializar ésta unidad',
  MSG_BUSQUEDA_DERIVADA: 'Perfecto, vamos a derivar la búsqueda al asesor de ventas para que te contacte y evalúen opciones',
  MSG_TEMPORARIO_DERIVADO: 'Perfecto, ya le pasé tu consulta al asesor. Te va a contactar para confirmarte la disponibilidad en esas fechas.',
  // Regla de Forja: si la ficha no dice nada sobre mascotas, se considera que acepta.
  MSG_MASCOTAS: 'En principio sí, te lo confirma el asesor',

  tokko: {
    api: 'https://www.tokkobroker.com/api/v1',
    get syncHoras() { return num('TOKKO_SYNC_HOURS', 6); },
    // Sin TOKKO_API_KEY el catálogo sale de este archivo (mismas fichas, mismo formato).
    fixtures: 'fixtures/tokko-fichas.json',
    // Tipos de operación de Tokko (por nombre, sin mayúsculas ni acentos) → cómo
    // los trata el agente. "Alquiler temporario" es un tipo propio en Tokko.
    // A confirmar contra la cuenta de Forja cuando llegue la API key.
    operaciones: { venta: 'venta', alquiler: 'alquiler', 'alquiler temporario': 'temporario', 'alquiler temporal': 'temporario' },
    // Códigos de estado de Tokko. A verificar contra la cuenta de Forja cuando llegue la API key.
    estados: { 1: 'no_disponible', 2: 'disponible', 3: 'reservada', 4: 'no_disponible' },
    // Minutos que vale el refresco puntual de una unidad antes de volver a consultar la API.
    refrescoMinutos: 5,
  },

  // Tipos de propiedad que no llevan dormitorios en el brief de búsqueda.
  tiposSinDormitorios: ['monoambiente', 'loft', 'terreno', 'lote', 'local', 'cochera', 'oficina', 'galpon', 'campo', 'nave', 'fondo de comercio'],

  // Etapa de pruebas: quien escriba exactamente este mensaje arranca de cero.
  // APAGAR (poner null) antes de abrir el número al público.
  pruebas: { reiniciar: '#reiniciar' },
};
