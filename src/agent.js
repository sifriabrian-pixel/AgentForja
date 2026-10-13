// Adapter de WhatsApp: ejecuta lo que decide el core (src/core.js).
//
// Flujo de un mensaje entrante:
//   webhook → core.ingest (referral ANTES de todo; wa_message_id UNIQUE = filtro
//   de duplicados) → agent.kick(waId) → core.processPending → envío por WhatsApp
//
// kick() procesa los mensajes pendientes de un número de a uno por vez (bloqueo
// por número). Si llegan varios seguidos se responden juntos en un solo turno.
// El estado vive en la base: si el proceso se reinicia, recover() retoma los
// mensajes que quedaron pendientes.
const config = require('../config/forja');
const repo = require('./repo');
const whatsapp = require('./whatsapp');
const core = require('./core');
const handoff = require('./handoff');

const MAX_INTENTOS = 3;
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 20000);
// Antes de responder se espera a que el lead deje de escribir, para contestar
// juntos los mensajes que llegan seguidos.
const esperaMs = () => Number(process.env.ESPERA_MENSAJES_MS ?? 3000);
const MAX_AVISOS = 5;
const MSG_REINICIO = 'Conversación reiniciada. Podés empezar de nuevo.';
const MSG_ERROR = 'Disculpá, tuvimos un inconveniente técnico. ¿Me escribís de nuevo en unos minutos?';

// ─── Texto que representa cada tipo de mensaje de WhatsApp ───────────────────
function describeInbound(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || '[Tocó un botón]';
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Respondió un mensaje interactivo]';
    case 'image': return `[Envió una imagen${msg.image?.caption ? `: ${msg.image.caption}` : ''}]`;
    case 'document': return `[Envió un documento${msg.document?.filename ? `: ${msg.document.filename}` : ''}]`;
    case 'audio': return '[Envió un audio que no se puede escuchar]';
    case 'video': return '[Envió un video que no se puede ver]';
    case 'sticker': return '[Envió un sticker]';
    case 'location': return `[Envió una ubicación${msg.location?.name ? `: ${msg.location.name}` : ''}]`;
    default: return `[Envió un mensaje de tipo ${msg.type}]`;
  }
}

function mediaIdOf(msg) {
  return msg[msg.type]?.id || null;
}

// ─── Derivaciones ────────────────────────────────────────────────────────────
// La lógica (ventana de 24 hs, plantilla, entrega al toque del botón) vive en
// src/handoff.js; acá solo se le pasa WhatsApp como medio de envío.

async function notifyHandoff({ derivacionId }) {
  const resultado = await handoff.entregar(derivacionId, whatsapp);
  if (resultado === 'fallido') console.error(`[derivacion] No se pudo avisar por la derivación ${derivacionId}; se reintenta`);
  return resultado;
}

// Alejandro escribió o tocó "Recibir para reenviar": recibe en limpio todo lo pendiente.
// Los toques se procesan de a uno, así el segundo no encuentra nada para reenviar.
let cola = Promise.resolve(0);
function handoffInbound() {
  handoff.registrarEntrante();
  cola = cola.then(() => handoff.alEscribirAlejandro(whatsapp)).then((n) => {
    if (n) console.log(`[derivacion] ${n} brief(s) entregado(s) a pedido de Alejandro`);
    return n;
  }).catch((e) => {
    console.error('[derivacion] Error entregando los briefs pendientes:', e.message);
    return 0;
  });
  return cola;
}

// Briefs que no salieron (falló el envío o el proceso se cortó): se vuelven a
// intentar al arrancar y cada pocos minutos, hasta MAX_AVISOS veces.
let reintentando = false;
async function retryNotices() {
  if (reintentando || !config.HANDOFF_WHATSAPP) return 0;
  reintentando = true;
  try {
    const hace2min = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    return await handoff.reintentar(whatsapp, { maxIntentos: MAX_AVISOS, creadosAntesDe: hace2min });
  } finally {
    reintentando = false;
  }
}

// ─── Seguimiento ─────────────────────────────────────────────────────────────

async function sendFollowup(payload) {
  const { waId, via, texto, plantilla, idioma, params } = payload;
  try {
    const res = via === 'plantilla' ? await whatsapp.sendTemplate(waId, plantilla, idioma, params) : await whatsapp.sendMessage(waId, texto);
    core.confirmFollowup(payload, { ok: true, waMessageId: res?.messages?.[0]?.id || null });
    console.log(`[seguimiento] Enviado a ${waId} (${via})`);
  } catch (e) {
    // Plantilla sin aprobar, número inválido, etc. No se reintenta ni se manda texto libre.
    console.error(`[seguimiento] No se pudo enviar a ${waId} (${via}):`, e.message);
    core.confirmFollowup(payload, { ok: false, error: e.message });
  }
}

// Job de seguimientos: se corre cada 15 minutos. Idempotente: cada seguimiento
// se toma una sola vez (claim en la base) antes de enviarlo.
let siguiendo = false;
async function runFollowups() {
  if (siguiendo) return 0;
  siguiendo = true;
  let enviados = 0;
  try {
    for (const f of repo.dueFollowups()) {
      const lead = repo.getLead(f.lead_id);
      // Solo el lead actual del número: uno cerrado por #reiniciar no se sigue.
      if (repo.getCurrentLead(lead.wa_id).id !== lead.id) {
        repo.setFollowup(f.id, 'cancelled', 'cerrado');
        continue;
      }
      const out = await core.tick(lead.wa_id);
      for (const action of out.actions) {
        if (action.type === 'send_followup') {
          await sendFollowup(action.payload);
          enviados += 1;
        }
      }
    }
  } finally {
    siguiendo = false;
  }
  return enviados;
}

async function runActions(actions) {
  for (const action of actions) {
    if (action.type === 'notify_handoff') await notifyHandoff(action.payload);
  }
}

// ─── Turno ───────────────────────────────────────────────────────────────────

// Devuelve true si el turno quedó cerrado; false si hay que reintentar más tarde.
async function processTurn(waId) {
  const out = await core.processPending(waId, undefined, {
    // Claude falló: se reintenta más tarde y al tercer error se manda una disculpa.
    onLlmError: (e, { lead, pendientes }) => {
      console.error(`[agent] Error de Claude para ${waId}:`, e.message);
      repo.bumpAttempts(pendientes.map((m) => m.id));
      const intentos = Math.max(...pendientes.map((m) => m.attempts)) + 1;
      repo.addEvent(lead.id, 'llm_error', { error: e.message, intento: intentos });
      if (intentos < MAX_INTENTOS) {
        setTimeout(() => kick(waId), RETRY_BASE_MS * intentos).unref();
        return null;
      }
      return MSG_ERROR;
    },
  });
  if (!out) return false;

  await runActions(out.actions);

  const [texto] = out.messages;
  const { leadId, outboundId } = out.meta;
  if (!texto) return true;
  try {
    const res = await whatsapp.sendMessage(waId, texto);
    repo.markOutbound(outboundId, 'enviado', res?.messages?.[0]?.id || null);
    repo.updateLead(leadId, { last_outbound_at: new Date().toISOString() });
  } catch (e) {
    console.error(`[wa] Error enviando a ${waId}:`, e.message);
    repo.markOutbound(outboundId, 'fallido');
    repo.addEvent(leadId, 'send_failed', { error: e.message });
  }
  return true;
}

// ─── Cola por número ─────────────────────────────────────────────────────────
// Una sola instancia del servicio: el bloqueo por número vive en el proceso,
// pero lo que bloquea son filas de la base, que sobreviven al reinicio.
const enCurso = new Map(); // waId → { again, promise }
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera hasta que pase ese tiempo sin mensajes nuevos de ese número (con tope).
async function esperarSilencio(waId) {
  const espera = esperaMs();
  if (!espera) return;
  const tope = Date.now() + espera * 4;
  let cantidad = repo.pendingInbound(waId).length;
  for (;;) {
    await dormir(espera);
    const ahora = repo.pendingInbound(waId).length;
    if (ahora === cantidad || Date.now() >= tope) return;
    cantidad = ahora;
  }
}

function kick(waId) {
  if (enCurso.has(waId)) {
    enCurso.get(waId).again = true;
    return enCurso.get(waId).promise;
  }
  const estado = { again: false, promise: null };
  estado.promise = (async () => {
    try {
      do {
        estado.again = false;
        if (!repo.pendingInbound(waId).length) break;
        await esperarSilencio(waId);
        const cerrado = await processTurn(waId);
        if (!cerrado) break; // reintento programado
      } while (estado.again || repo.pendingInbound(waId).length);
    } catch (e) {
      console.error(`[agent] Error procesando ${waId}:`, e);
    } finally {
      enCurso.delete(waId);
    }
  })();
  enCurso.set(waId, estado);
  return estado.promise;
}

// Al arrancar: retomar lo que quedó a mitad de camino.
function recover() {
  const trabados = repo.markStuckOutbound();
  if (trabados) console.warn(`[agent] ${trabados} mensaje(s) saliente(s) quedaron sin confirmar en el reinicio anterior`);
  const avisos = repo.releaseStuckDerivaciones();
  if (avisos) console.warn(`[agent] ${avisos} derivación(es) quedaron a medio enviar: se reintentan`);
  const numeros = repo.waIdsWithPending();
  if (numeros.length) console.log(`[agent] Retomando ${numeros.length} conversación(es) con mensajes pendientes`);
  return Promise.all(numeros.map((n) => kick(n)));
}

// Reinicio de pruebas (config.pruebas.reiniciar): el número arranca de cero.
async function reset(waId) {
  if (enCurso.has(waId)) await enCurso.get(waId).promise;
  const lead = repo.resetConversation(waId);
  console.log(`[pruebas] Conversación reiniciada: ${waId}`);
  try {
    await whatsapp.sendMessage(waId, MSG_REINICIO);
  } catch (e) {
    console.error(`[wa] Error enviando a ${waId}:`, e.message);
  }
  return lead;
}

// Respuesta a un comando de HANDOFF_WHATSAPP (#pausa / #reanudar).
async function replyCommand(to, texto) {
  try {
    await whatsapp.sendMessage(to, texto);
  } catch (e) {
    console.error(`[comandos] No se pudo responder a ${to}:`, e.message);
  }
}

function idle() {
  return Promise.all([cola, ...[...enCurso.values()].map((e) => e.promise)]);
}

module.exports = { kick, recover, idle, reset, retryNotices, handoffInbound, runFollowups, replyCommand, describeInbound, mediaIdOf };
