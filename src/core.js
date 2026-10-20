// Core del agente: toda la lógica de un turno, sin transporte.
//
// Nunca envía nada ni llama a WhatsApp: devuelve lo que habría que enviar
// (messages) y los efectos a ejecutar (actions). El adapter de WhatsApp
// (agent.js) los ejecuta; el de test (test-adapter.js) solo los registra.
//
//   ingest(input)                     guarda el origen y el mensaje (antes de responder)
//   processPending(conversationId)    responde lo pendiente de ese número
//   handleMessage(input)              = ingest + processPending (lo que usa el QA)
//   registerEcho(input)               una persona escribió desde el número de Forja → pausa
//   command(text)                     #pausa / #reanudar (solo desde HANDOFF_WHATSAPP)
//   tick(conversationId, now)         seguimiento programado de ese número
//
// AgentInput  = { conversationId, from, text, now?, messageId?, type?,
//                 attachments?: [{ type, mediaId }],
//                 metadata?: { adId, referral?, profileName? } }
// AgentAction = { type: 'notify_handoff', payload: { derivacionId, tipo, texto, nota } }
//             | { type: 'send_followup', payload: { followupId, via, texto, plantilla?, idioma?, params? } }
// AgentOutput = { messages, actions, state, meta }
//
// conversationId es el wa_id del lead. deps = { store, llm, onLlmError }.
const crypto = require('crypto');
const config = require('../config/forja');
const repo = require('./repo');
const claude = require('./claude');
const clock = require('./clock');
const tokko = require('./tokko');
const briefs = require('./briefs');
const seguimiento = require('./seguimiento');
const { digitos } = require('./numeros');

const MAX_VUELTAS_TURNO = 3;
const MSG_VACIO = 'Disculpá, no llegué a entender tu mensaje. ¿Me lo escribís de otra forma?';
const HORA = 60 * 60 * 1000;

const nombreDe = (lead, dado) => (dado && String(dado).trim()) || lead.datos.nombre || lead.nombre_perfil || null;

// ─── Herramientas ────────────────────────────────────────────────────────────

async function applyGetProperty(waId, input, store = repo) {
  const lead = store.getCurrentLead(waId);
  const res = tokko.buscar(input.referencia);
  if (res.candidatas) {
    return JSON.stringify({
      candidatas: res.candidatas.map(tokko.resumen),
      instruccion: 'Hay más de una unidad parecida. Preguntale al lead cuál es (por dirección o zona) y volvé a llamar con el id.',
    });
  }
  if (!res.propiedad) {
    store.addEvent(lead.id, 'propiedad_no_encontrada', { referencia: input.referencia });
    return 'No se encontró esa unidad en el catálogo. No inventes datos: pedile la dirección o el link de la publicación.';
  }

  // Estado y precio actuales, directo de Tokko, antes de hablar de disponibilidad.
  const { propiedad, verificada } = await tokko.refrescar(res.propiedad.id);
  store.mergeDatos(lead.id, { propiedad_id: propiedad.id });
  store.addEvent(lead.id, 'propiedad_consultada', { propiedad_id: propiedad.id, por: res.por, estado: propiedad.estado, verificada });

  const ficha = tokko.fichaParaAgente(propiedad);
  // Bloque listo para mandar al lead la primera vez que se presenta la unidad.
  ficha.ficha_whatsapp = tokko.fichaWhatsApp(propiedad);
  if (process.env.TOKKO_API_KEY && !verificada) ficha.disponibilidad_sin_verificar = true;
  if (propiedad.estado !== 'disponible') ficha.instruccion = 'Esta unidad NO está disponible. Avisalo con tacto y preguntá "¿qué estás buscando?".';
  return JSON.stringify(ficha);
}

async function applyDerivarVisita(waId, input, store = repo) {
  const lead = store.getCurrentLead(waId);
  const local = tokko.get(input.propiedad_id) || tokko.buscar(input.propiedad_id).propiedad;
  if (!local) return 'No se derivó: esa unidad no existe en el catálogo. Llamá primero a get_property para identificarla.';

  const { propiedad } = await tokko.refrescar(local.id);
  if (propiedad.estado !== 'disponible') {
    return `No se derivó: la unidad figura como ${propiedad.estado.replace('_', ' ')}. Avisale con tacto y preguntá "¿qué estás buscando?".`;
  }

  const nombre = nombreDe(lead, input.nombre);
  store.mergeDatos(lead.id, { nombre: input.nombre, propiedad_id: propiedad.id });
  const texto = briefs.briefVisita({ propiedad, disponibilidad: input.disponibilidad, destino: input.destino, plazo: input.plazo }, { waId, nombre });
  const { creada } = store.createDerivacion({
    leadId: lead.id, tipo: 'visita', clave: `visita:${propiedad.id}`, destino: config.HANDOFF_WHATSAPP, texto,
    datos: { propiedad_id: propiedad.id, disponibilidad: input.disponibilidad || null, destino: input.destino || null, plazo: input.plazo || null },
  });
  if (!creada) return 'Ese pedido de visita ya estaba derivado (no se volvió a enviar). Decile que su pedido ya está en manos del asesor y que lo va a contactar.';
  store.cancelFollowup(lead.id, 'derivado');
  return `Visita derivada. Respondele exactamente esto: "${config.MSG_VISITA_DERIVADA}"`;
}

function origenDe(lead, dado) {
  const prop = lead.datos.propiedad_id ? tokko.get(lead.datos.propiedad_id) : null;
  if (prop) return `consultó por ${prop.direccion} (cód. Tokko ${prop.id})`;
  if (lead.source === 'ctwa') {
    const titulo = lead.referral?.headline || lead.referral?.body;
    return titulo ? `anuncio "${String(titulo).slice(0, 80)}"` : 'anuncio';
  }
  return dado || 'directo';
}

function applyDerivarBusqueda(waId, input, store = repo) {
  const lead = store.getCurrentLead(waId);
  // Forja solo hace búsquedas de compra.
  if (String(input.operacion || '').toLowerCase().startsWith('alquil')) {
    store.addEvent(lead.id, 'busqueda_rechazada', { motivo: 'alquiler' });
    return 'No se derivó: Forja no hace búsquedas de alquiler. Si llegó sin una unidad puntual, preguntá zona y fechas y llamá a derivar_a_humano con motivo "alquiler". Si declinó una unidad en alquiler, ofrecele ver otra unidad publicada o cerrá cordial.';
  }
  // Alejandro reenvía el brief tal cual: solo sale con los obligatorios completos.
  const faltan = briefs.faltantesBusqueda(input);
  if (faltan.length) {
    store.addEvent(lead.id, 'busqueda_incompleta', { faltan });
    return `No se derivó. Faltan: ${faltan.join(', ')}. Preguntale ese dato al lead y volvé a llamar cuando lo tengas. Lo único que puede quedar "${briefs.A_CONFIRMAR}" es el presupuesto. No le digas que ya lo derivaste.`;
  }

  const nombre = nombreDe(lead, input.nombre);
  const datos = { ...input, origen: origenDe(lead, input.origen) };
  store.mergeDatos(lead.id, { nombre: input.nombre, busqueda: datos });
  const { creada } = store.createDerivacion({
    leadId: lead.id, tipo: 'busqueda', clave: 'busqueda', destino: config.HANDOFF_WHATSAPP,
    texto: briefs.briefBusqueda(datos, { waId, nombre }), nota: briefs.notaBusqueda(datos), datos,
  });
  if (!creada) return 'Esa búsqueda ya estaba derivada (no se volvió a enviar). Decile que el asesor ya tiene su búsqueda y que lo va a contactar.';
  store.cancelFollowup(lead.id, 'derivado');
  return `Búsqueda derivada. Respondele exactamente esto: "${config.MSG_BUSQUEDA_DERIVADA}"`;
}

async function applyDerivarTemporario(waId, input, store = repo) {
  const lead = store.getCurrentLead(waId);
  const local = tokko.get(input.propiedad_id) || tokko.buscar(input.propiedad_id).propiedad;
  if (!local) return 'No se derivó: esa unidad no existe en el catálogo. Llamá primero a get_property para identificarla.';
  const faltan = briefs.faltantesTemporario(input);
  if (faltan.length) return `No se derivó. Faltan: ${faltan.join(', ')}. Preguntale ese dato al lead y volvé a llamar cuando lo tengas.`;

  const { propiedad } = await tokko.refrescar(local.id);
  if (propiedad.estado !== 'disponible') {
    return `No se derivó: la unidad figura como ${propiedad.estado.replace('_', ' ')}. Avisale con tacto.`;
  }

  const nombre = nombreDe(lead, input.nombre);
  store.mergeDatos(lead.id, { nombre: input.nombre, propiedad_id: propiedad.id });
  const texto = briefs.briefTemporario({ propiedad, ...input }, { waId, nombre });
  const { creada } = store.createDerivacion({
    leadId: lead.id, tipo: 'temporario', clave: `temporario:${propiedad.id}`, destino: config.HANDOFF_WHATSAPP, texto,
    datos: { propiedad_id: propiedad.id, fecha_ingreso: input.fecha_ingreso, fecha_salida: input.fecha_salida, personas: input.personas },
  });
  if (!creada) return 'Esa consulta de alquiler temporario ya estaba derivada (no se volvió a enviar). Decile que el asesor ya la tiene y lo va a contactar.';
  store.cancelFollowup(lead.id, 'derivado');
  return `Alquiler temporario derivado. No confirmes que esas fechas están libres. Respondele exactamente esto: "${config.MSG_TEMPORARIO_DERIVADO}"`;
}

function applyDerivarAHumano(waId, input, store = repo) {
  const lead = store.getCurrentLead(waId);
  const motivo = briefs.MOTIVOS[input.motivo] ? input.motivo : 'consulta_sin_respuesta';
  const nombre = nombreDe(lead, input.nombre);
  store.mergeDatos(lead.id, { nombre: input.nombre, colega: motivo === 'colega' ? true : undefined });
  const texto = briefs.briefHumano({ motivo, resumen: input.resumen }, { waId, nombre });
  const { creada } = store.createDerivacion({ leadId: lead.id, tipo: 'humano', clave: `humano:${motivo}`, destino: config.HANDOFF_WHATSAPP, texto, datos: { motivo, resumen: input.resumen } });
  store.cancelFollowup(lead.id, motivo === 'colega' ? 'colega' : 'derivado');

  // A partir de acá responde una persona: el agente se calla en esta conversación.
  const hasta = new Date(clock.date().getTime() + config.HUMAN_TAKEOVER_HOURS * HORA).toISOString();
  store.pause(lead.id, hasta, 'derivado_a_humano');

  if (!creada) return 'Ya estaba derivado a una persona (no se volvió a enviar). Decile que un asesor ya tiene su consulta y lo va a contactar.';
  return 'Derivado a una persona. Avisale en un mensaje breve que lo va a contactar un asesor. No respondas la consulta ni prometas horarios.';
}

function applyProgramarSeguimiento(waId, input, store = repo) {
  const lead = store.getCurrentLead(waId);
  const sin = seguimiento.motivoSinSeguimiento(lead);
  if (sin) return `No se agenda seguimiento (${sin.replace('_', ' ')}).`;
  seguimiento.programar(lead, store);
  store.addEvent(lead.id, 'seguimiento_pedido', { motivo: input.motivo || null });
  return 'Seguimiento agendado. Cerrá cordial, sin presionar.';
}

function applyCancelarSeguimiento(waId, _input, store = repo) {
  const lead = store.getCurrentLead(waId);
  store.mergeDatos(lead.id, { no_contactar: true });
  store.cancelFollowup(lead.id, 'no_contactar');
  store.addEvent(lead.id, 'no_contactar');
  return 'Anotado: no se lo vuelve a contactar. Despedite con cordialidad.';
}

function applySearchProperties(input) {
  if (!config.ENABLE_PROPERTY_SEARCH) return 'La búsqueda en cartera no está habilitada: la hace el asesor. Seguí con derivar_busqueda.';
  const res = tokko.filtrar(input);
  return res.length ? JSON.stringify(res.map(tokko.resumen)) : 'Sin resultados. No inventes opciones: seguí con derivar_busqueda.';
}

function handlers(waId, store) {
  return {
    get_property: (input) => applyGetProperty(waId, input, store),
    derivar_visita: (input) => applyDerivarVisita(waId, input, store),
    derivar_alquiler_temporario: (input) => applyDerivarTemporario(waId, input, store),
    derivar_busqueda: (input) => applyDerivarBusqueda(waId, input, store),
    derivar_a_humano: (input) => applyDerivarAHumano(waId, input, store),
    programar_seguimiento: (input) => applyProgramarSeguimiento(waId, input, store),
    cancelar_seguimiento: (input) => applyCancelarSeguimiento(waId, input, store),
    search_properties: (input) => applySearchProperties(input),
  };
}

// ─── Contexto del turno ──────────────────────────────────────────────────────

function fechaLocal() {
  return clock.date().toLocaleString('es-AR', { timeZone: config.TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function buildContext(lead, filas, store = repo) {
  const salientes = filas.filter((m) => m.direction === 'out');
  const lineas = [
    'CONTEXTO DE ESTA CONVERSACIÓN (información del sistema; no la cites textual):',
    `- Fecha y hora en Argentina: ${fechaLocal()}`,
    `- Saludo que corresponde ahora: "${seguimiento.saludo()}"`,
    salientes.length
      ? '- Ya saludaste en esta conversación: no vuelvas a saludar ni a presentarte.'
      : '- Es tu primer mensaje en esta conversación: saludá y pedí el nombre.',
  ];

  if (lead.datos.nombre) lineas.push(`- Nombre que dio: ${lead.datos.nombre}`);
  else if (lead.nombre_perfil) lineas.push(`- Nombre del perfil de WhatsApp: ${lead.nombre_perfil} (puede no ser el real; pedí el nombre igual)`);

  if (lead.source === 'ctwa') {
    const r = lead.referral || {};
    const anuncio = [r.headline, r.body].filter(Boolean).join(' — ').slice(0, 300);
    lineas.push(`- Llegó desde un anuncio de Meta.${anuncio ? ` Texto del anuncio: "${anuncio}".` : ''}${r.source_url ? ` Link: ${r.source_url}` : ''}`);
    if (!lead.datos.propiedad_id) lineas.push('  Si el anuncio es de una unidad puntual, identificala con get_property usando ese texto o link.');
  } else {
    lineas.push('- Llegó de forma orgánica (no desde un anuncio).');
  }

  const prop = lead.datos.propiedad_id ? tokko.get(lead.datos.propiedad_id) : null;
  if (prop) {
    lineas.push(`- Unidad por la que consulta (ficha de Tokko; es lo único que sabés de ella):\n${JSON.stringify(tokko.fichaParaAgente(prop))}`);
  }

  // El presupuesto se pregunta una sola vez: lo controla el código, no la memoria del modelo.
  if (salientes.some((m) => m.type === 'text' && /presupuesto/i.test(m.body || ''))) {
    lineas.push('- Presupuesto: YA lo preguntaste una vez. No lo vuelvas a preguntar ni a mencionar; si no lo tenés, va "a confirmar".');
  }

  const derivaciones = store.derivacionesDe(lead.id);
  if (derivaciones.length) {
    lineas.push(`- Ya derivado a un asesor: ${derivaciones.map((d) => d.clave.replace(':', ' ')).join(', ')}. No lo vuelvas a derivar por lo mismo.`);
  }

  const ultimoSaliente = salientes[salientes.length - 1];
  if (ultimoSaliente?.type === 'followup') {
    lineas.push('- Tu último mensaje fue el de seguimiento ("¿tenés alguna búsqueda activa...?"). Si responde con interés: si quiere comprar, modo búsqueda; si quiere alquilar, zona y fechas y derivar_a_humano con motivo "alquiler".');
  }
  if (lead.datos.no_contactar) lineas.push('- Pidió que no lo contacten: respondé solo lo que pregunte, sin proponer nada.');
  return lineas.join('\n');
}

// Convierte el historial de la base al formato de la API: alterna roles,
// une mensajes seguidos del mismo rol y arranca siempre con el usuario.
function toApiMessages(rows) {
  const out = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const body = r.type === 'echo' ? `[Mensaje escrito por una persona del equipo de Forja] ${r.body}` : r.body;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${body}`;
    else out.push({ role, content: body });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ─── Estado y acciones ───────────────────────────────────────────────────────

// Foto del lead para quien llama.
function buildState(lead, store = repo) {
  if (!lead) return { leadId: null, nombre: null, datos: {}, propiedadId: null, derivaciones: [], derived: false, paused: false, followup: null };
  const followup = store.getFollowup(lead.id);
  return {
    leadId: lead.id,
    nombre: lead.datos.nombre || lead.nombre_perfil || null,
    datos: lead.datos,
    propiedadId: lead.datos.propiedad_id || null,
    derivaciones: store.derivacionesDe(lead.id).map((d) => ({ tipo: d.tipo, clave: d.clave, texto: d.texto, status: d.status })),
    derived: Boolean(lead.derived_at),
    paused: store.isPaused(lead),
    pausedUntil: store.isPaused(lead) ? lead.paused_until : null,
    followup: followup ? { status: followup.status, dueAt: followup.due_at, reason: followup.reason, enviados: followup.step } : null,
    status: lead.status,
    source: lead.source,
  };
}

const salida = (lead, store, extra = {}) => ({
  messages: [], actions: [], state: buildState(lead, store), meta: { leadId: lead?.id || null, outboundId: null }, ...extra,
});

// texto = el brief, limpio; nota = segundo mensaje aparte (o null).
const accionAviso = (d) => ({ type: 'notify_handoff', payload: { derivacionId: d.id, leadId: d.lead_id, tipo: d.tipo, texto: d.texto, nota: d.nota || null } });

// El lead escribe con el agente en pausa. Si desde que empezó la pausa ninguna
// persona le respondió desde el número de Forja, se le avisa a Alejandro para
// que no quede hablándole a la nada. Una sola vez por pausa: la clave del
// aviso es el inicio de la pausa, y la base no admite dos con la misma clave.
function avisoDePausa(lead, pendientes, store) {
  const inicio = lead.paused_at || lead.updated_at;
  if (store.echoDesde(lead.wa_id, inicio)) return [];
  const mensaje = pendientes.map((m) => m.body).filter(Boolean).join(' / ').replace(/\s+/g, ' ').trim().slice(0, 400);
  const texto = config.MSG_AVISO_PAUSA
    .replace('{nombre}', lead.datos.nombre || lead.nombre_perfil || 'sin nombre')
    .replace('{telefono}', briefs.telefono(lead.wa_id))
    .replace('{mensaje}', mensaje || '(mensaje sin texto)');
  const { creada, derivacion } = store.createDerivacion({ leadId: lead.id, tipo: 'aviso', clave: `aviso:${inicio}`, destino: config.HANDOFF_WHATSAPP, texto });
  if (!creada) return [];
  store.addEvent(lead.id, 'aviso_pausa', { derivacion_id: derivacion.id });
  return [accionAviso(derivacion)];
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

function referralOf(metadata = {}) {
  if (metadata.referral) return metadata.referral;
  if (metadata.adId) return { source_id: metadata.adId, source_type: 'ad' };
  return null;
}

// Guarda el origen del lead y el mensaje como pendiente. Es sincrónico: el
// webhook lo llama ANTES de responder 200 y antes de cualquier llamada al LLM.
// Un input sin texto ni adjuntos solo registra el origen (reacciones, etc.).
// Devuelve { lead, nuevo }; nuevo = false si el mensaje ya estaba (duplicado).
function ingest(input, { store = repo } = {}) {
  return clock.run(input.now, () => {
    const waId = input.conversationId;
    const metadata = input.metadata || {};
    const lead = store.captureInbound(waId, metadata.profileName || null, referralOf(metadata));

    const adjunto = (input.attachments || [])[0] || null;
    if (input.text == null && !adjunto) return { lead, nuevo: false };

    const nuevo = store.insertInbound({
      waId,
      leadId: lead.id,
      waMessageId: input.messageId || `core.${crypto.randomUUID()}`,
      type: input.type || adjunto?.type || 'text',
      body: input.text,
      mediaId: adjunto?.mediaId || null,
    });
    // El lead volvió a escribir: el seguimiento pendiente ya no corresponde.
    if (nuevo) store.cancelFollowup(lead.id, 'lead_escribio');
    return { lead, nuevo };
  });
}

// ─── Intervención humana ─────────────────────────────────────────────────────

// Una persona escribió desde el número de Forja (echo de coexistencia): el
// agente se calla en esa conversación por HUMAN_TAKEOVER_HOURS.
// Devuelve { pausado } — false si el echo era un duplicado o un mensaje del propio agente.
function registerEcho(input, { store = repo } = {}) {
  return clock.run(input.now, () => {
    const waId = input.conversationId;
    const lead = store.captureInbound(waId, null, null);
    // El echo y el inicio de la pausa llevan la misma hora: así el echo cuenta
    // como "una persona ya le respondió" y no se le avisa de más a Alejandro.
    const ts = clock.nowISO();
    const nuevo = store.insertEcho({ waId, leadId: lead.id, waMessageId: input.messageId || `echo.${crypto.randomUUID()}`, body: input.text || '[mensaje sin texto]', createdAt: ts });
    if (!nuevo) return { pausado: false, lead };
    const hasta = new Date(new Date(ts).getTime() + config.HUMAN_TAKEOVER_HOURS * HORA).toISOString();
    // Una pausa manual sin vencimiento (#pausa) no se acorta por un echo.
    if (!lead.paused_until || lead.paused_until < hasta) store.pause(lead.id, hasta, 'echo', ts);
    return { pausado: true, lead: store.getLead(lead.id) };
  });
}

// Comandos de HANDOFF_WHATSAPP: "#pausa <número>" / "#reanudar <número>".
// Quien llama ya verificó que el mensaje viene de ese número.
// Devuelve { esComando, reply } con el texto para responderle.
function command(text, { store = repo, now } = {}) {
  return clock.run(now, () => {
    const [cmd, ...resto] = String(text || '').trim().split(/\s+/);
    const accion = cmd.toLowerCase() === config.comandos.pausa ? 'pausa' : cmd.toLowerCase() === config.comandos.reanudar ? 'reanudar' : null;
    if (!accion) return { esComando: false, reply: null };

    const numero = digitos(resto.join(''));
    if (numero.length < 8) return { esComando: true, reply: `Falta el número. Ejemplo: ${config.comandos[accion]} 5493415551234` };
    const lead = store.findLeadByNumber(numero);
    if (!lead) return { esComando: true, reply: `No encontré una conversación con el número ${numero}. Revisá que esté completo, con código de país.` };

    if (accion === 'pausa') {
      store.pause(lead.id, null, 'comando');
      return { esComando: true, reply: `Listo: el agente no responde más a +${lead.wa_id}. Para volver a activarlo: ${config.comandos.reanudar} ${lead.wa_id}`, lead: store.getLead(lead.id) };
    }
    store.resume(lead.id, 'comando');
    return { esComando: true, reply: `Listo: el agente vuelve a responder a +${lead.wa_id}.`, lead: store.getLead(lead.id) };
  });
}

// El primer mensaje de la conversación siempre saluda según la hora y se
// presenta (frase de Alejandro). El modelo a veces lo saltea cuando el lead
// arranca con un link; acá se garantiza en código. Si todavía no se sabe el
// nombre y la respuesta no lo pide, se pide al final.
function asegurarSaludo(texto, filas, lead) {
  if (filas.some((m) => m.direction === 'out')) return texto;
  let salida = texto;
  if (!/^\s*buen[oa]s (d[ií]as|tardes|noches)/i.test(salida)) {
    salida = `${seguimiento.saludo()} ¿cómo estás? Te saluda ${config.AGENT_IDENTITY}.\n\n${salida}`;
  }
  if (!lead.datos.nombre && !/nombre/i.test(salida) && !lead.derived_at) {
    // Una sola pregunta por mensaje: si el modelo ya cerró con otra, la del nombre la reemplaza.
    const sinPregunta = salida.replace(/\s*¿[^¿]*\?\s*$/, '').trimEnd();
    salida = `${sinPregunta}\n\n¿Me dirías tu nombre?`;
  }
  return salida;
}

// ─── Turno ───────────────────────────────────────────────────────────────────

// Responde los mensajes pendientes de un número en un solo turno. Deja la
// respuesta guardada en estado 'enviando' y la devuelve en messages: enviarla
// (y marcarla como enviada) es trabajo del adapter.
//
// Si Claude falla: sin onLlmError, lanza. Con onLlmError(error, { lead,
// pendientes }), el adapter decide: devuelve un texto para cerrar el turno
// con ese mensaje, o null para dejarlo pendiente (processPending devuelve null).
async function turno(waId, deps = {}, vuelta = 1, yaDerivadas = null) {
  const { store = repo, llm = claude, onLlmError } = deps;
  const pendientes = store.pendingInbound(waId);
  let lead = store.getCurrentLead(waId);
  if (!pendientes.length) return salida(lead, store);

  // Conversación en manos de una persona: los mensajes quedan en el historial, sin respuesta.
  if (store.isPaused(lead)) {
    const actions = avisoDePausa(lead, pendientes, store);
    store.swallowPending(waId);
    return salida(lead, store, { actions, meta: { leadId: lead.id, outboundId: null, paused: true } });
  }

  // Derivaciones que ya existían antes del turno: lo que aparezca de más, se creó acá.
  const previas = yaDerivadas || new Set(store.derivacionesDe(lead.id).map((d) => d.id));

  const filas = store.history(waId);
  const historial = toApiMessages([...filas, ...pendientes.filter((m) => m.body)]);
  let texto;
  try {
    const res = await llm.chat(historial, buildContext(lead, filas, store), handlers(waId, store));
    texto = (res.texto || '').trim();
    if (res.stopReason === 'refusal') store.addEvent(lead.id, 'llm_refusal');
  } catch (e) {
    if (!onLlmError) throw e;
    texto = await onLlmError(e, { lead, pendientes });
    if (texto == null) return null;
  }

  // Entraron mensajes mientras Claude respondía: esa respuesta ya quedó vieja
  // (repetiría la pregunta). Se descarta y se responde todo junto.
  if (vuelta < MAX_VUELTAS_TURNO && store.pendingInbound(waId).length > pendientes.length) return turno(waId, deps, vuelta + 1, previas);

  lead = store.getCurrentLead(waId);
  const nuevas = store.derivacionesDe(lead.id).filter((d) => !previas.has(d.id));

  // Derivó pero no escribió nada: el lead igual recibe el mensaje que corresponde.
  if (!texto) {
    const ultima = nuevas[nuevas.length - 1];
    if (ultima?.tipo === 'visita') texto = config.MSG_VISITA_DERIVADA;
    else if (ultima?.tipo === 'temporario') texto = config.MSG_TEMPORARIO_DERIVADO;
    else if (ultima?.tipo === 'busqueda') texto = config.MSG_BUSQUEDA_DERIVADA;
    else if (ultima?.tipo === 'humano') texto = 'Gracias por escribir, te paso con un asesor que te responde eso.';
    else texto = MSG_VACIO;
  }

  texto = asegurarSaludo(texto, filas, lead);

  // Sin derivar y sin pausa: queda programado el seguimiento por si no vuelve a escribir.
  if (!store.isPaused(lead)) seguimiento.programar(lead, store);

  const outboundId = store.commitTurn({ waId, leadId: lead.id, inboundIds: pendientes.map((m) => m.id), replyText: texto });
  return { messages: [texto], actions: nuevas.map(accionAviso), state: buildState(lead, store), meta: { leadId: lead.id, outboundId } };
}

function processPending(conversationId, now, deps = {}) {
  return clock.run(now, () => turno(conversationId, deps));
}

function handleMessage(input, deps = {}) {
  return clock.run(input.now, () => {
    ingest(input, deps);
    return turno(input.conversationId, deps);
  });
}

// ─── Seguimiento ─────────────────────────────────────────────────────────────

// Mira el seguimiento de un número a la hora `now`. Si toca enviarlo, lo toma
// (un solo envío, pase lo que pase después) y devuelve la acción send_followup;
// el adapter envía y confirma con confirmFollowup().
async function tick(conversationId, now, { store = repo } = {}) {
  return clock.run(now, () => {
    const lead = store.getCurrentLead(conversationId);
    if (!lead) return salida(null, store);
    const [followup] = store.dueFollowups(lead.id);
    if (!followup) return salida(lead, store);

    const d = seguimiento.decidir(followup, lead, store);
    if (d.accion === 'cancelar') {
      store.setFollowup(followup.id, 'cancelled', d.motivo);
      store.addEvent(lead.id, 'followup_cancelled', { motivo: d.motivo });
      return salida(lead, store);
    }
    if (d.accion === 'esperar') {
      // Se anota una sola vez por motivo, para no llenar el registro cada 15 minutos.
      if (!store.events(lead.id).some((e) => e.type === 'followup_skipped' && e.payload?.motivo === d.motivo)) {
        store.addEvent(lead.id, 'followup_skipped', { motivo: d.motivo });
        if (d.motivo === 'sin_plantilla') console.warn(`[seguimiento] ${lead.wa_id}: fuera de la ventana de 24 hs y sin FOLLOWUP_TEMPLATE_NAME — no se envía`);
      }
      return salida(lead, store, { meta: { leadId: lead.id, outboundId: null, skipped: d.motivo } });
    }

    if (!store.claimFollowup(followup.id)) return salida(lead, store);
    const outboundId = store.insertOutbound({ waId: lead.wa_id, leadId: lead.id, type: 'followup', body: d.texto });
    const { accion, ...envio } = d;
    return {
      messages: [d.texto],
      actions: [{ type: 'send_followup', payload: { followupId: followup.id, leadId: lead.id, waId: lead.wa_id, outboundId, ...envio } }],
      state: buildState(lead, store),
      meta: { leadId: lead.id, outboundId },
    };
  });
}

// Resultado del envío del seguimiento. Si falló no se reintenta: reintentar
// arriesga un mensaje de más. Si salió y FOLLOWUP_DAYS tiene otro toque,
// queda programado; si no, ese lead no recibe más seguimientos.
function confirmFollowup({ followupId, leadId, outboundId }, { ok, waMessageId = null, error = null }, { store = repo } = {}) {
  if (ok) store.advanceFollowup(followupId, seguimiento.proximoVencimiento(store.getFollowupById(followupId)));
  else store.setFollowup(followupId, 'failed', String(error).slice(0, 300));
  store.markOutbound(outboundId, ok ? 'enviado' : 'fallido', waMessageId);
  store.addEvent(leadId, ok ? 'followup_sent' : 'followup_failed', ok ? null : { error: String(error).slice(0, 300) });
  if (ok) store.updateLead(leadId, { last_outbound_at: clock.nowISO() });
}

module.exports = {
  ingest, processPending, handleMessage, registerEcho, command, tick, confirmFollowup,
  buildState, buildContext, toApiMessages, accionAviso,
};
