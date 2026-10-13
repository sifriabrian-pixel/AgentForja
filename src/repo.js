// Acceso a datos. Todo el estado del agente se lee y escribe acá; nada
// crítico queda en memoria del proceso.
const crypto = require('crypto');
const db = require('./db');
const clock = require('./clock');
const { mismoNumero, coincideFinal } = require('./numeros');

const now = clock.nowISO;
const uuid = () => crypto.randomUUID();

function parseLead(row) {
  if (!row) return null;
  return {
    ...row,
    datos: JSON.parse(row.datos || '{}'),
    referral: row.referral ? JSON.parse(row.referral) : null,
  };
}

// ─── Leads ───────────────────────────────────────────────────────────────────

// Lead actual de un número = el último creado (#reiniciar crea uno nuevo).
function getCurrentLead(waId) {
  return parseLead(db.get().prepare('SELECT * FROM leads WHERE wa_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(waId));
}

function getLead(id) {
  return parseLead(db.get().prepare('SELECT * FROM leads WHERE id = ?').get(id));
}

function createLead(waId, { nombrePerfil = null } = {}) {
  const id = uuid();
  const ts = now();
  db.get().prepare('INSERT INTO leads (id, wa_id, nombre_perfil, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, waId, nombrePerfil, ts, ts);
  addEvent(id, 'created');
  return getLead(id);
}

// Guarda el referral del anuncio (Click-to-WhatsApp) en el lead actual.
// Se llama ANTES de mirar el tipo de mensaje y antes de cualquier llamada al LLM.
// Devuelve el lead (creándolo si no existía).
function captureInbound(waId, nombrePerfil, referral) {
  const conn = db.get();
  return conn.transaction(() => {
    let lead = getCurrentLead(waId);
    if (!lead) lead = createLead(waId, { nombrePerfil });
    else if (nombrePerfil && !lead.nombre_perfil) {
      conn.prepare('UPDATE leads SET nombre_perfil = ?, updated_at = ? WHERE id = ?').run(nombrePerfil, now(), lead.id);
    }

    if (referral) {
      const adId = referral.source_id || null;
      if (!lead.referral) {
        conn.prepare(`
          UPDATE leads SET source = 'ctwa', ad_id = ?, referral = ?, ctwa_clid = ?, updated_at = ?
          WHERE id = ? AND referral IS NULL
        `).run(adId, JSON.stringify(referral), referral.ctwa_clid || null, now(), lead.id);
        addEvent(lead.id, 'referral_captured', { ad_id: adId, source_type: referral.source_type || null });
      } else if (lead.ad_id !== adId) {
        // Volvió desde otro anuncio: se registra sin pisar el origen original.
        addEvent(lead.id, 'referral_repeat', referral);
      }
    }
    return getCurrentLead(waId);
  })();
}

function updateLead(id, campos) {
  const permitidos = ['datos', 'status', 'last_inbound_at', 'last_outbound_at', 'paused_until', 'paused_at', 'pause_reason'];
  const claves = Object.keys(campos).filter((k) => permitidos.includes(k));
  if (claves.length === 0) return;
  const valores = claves.map((k) => (k === 'datos' ? JSON.stringify(campos[k]) : campos[k]));
  db.get().prepare(`UPDATE leads SET ${claves.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...valores, now(), id);
}

// Suma datos a la ficha sin pisar los que ya estaban con valores vacíos.
function mergeDatos(id, nuevos) {
  const lead = getLead(id);
  const limpios = Object.fromEntries(Object.entries(nuevos).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  if (!Object.keys(limpios).length) return lead;
  updateLead(id, { datos: { ...lead.datos, ...limpios } });
  return getLead(id);
}

function markDerived(id) {
  const ts = now();
  db.get().prepare("UPDATE leads SET derived_at = COALESCE(derived_at, ?), status = 'derivado', updated_at = ? WHERE id = ?").run(ts, ts, id);
}

// Busca la conversación de un número escrito a mano (comandos #pausa / #reanudar).
// Devuelve el lead actual de ese número, o null si no hay o si hay más de uno posible.
function findLeadByNumber(numero) {
  const waIds = db.get().prepare('SELECT DISTINCT wa_id FROM leads').all().map((r) => r.wa_id);
  let candidatos = waIds.filter((w) => mismoNumero(w, numero));
  if (!candidatos.length) candidatos = waIds.filter((w) => coincideFinal(w, numero));
  return candidatos.length === 1 ? getCurrentLead(candidatos[0]) : null;
}

// ─── Pausa (intervención humana) ─────────────────────────────────────────────

const SIN_VENCIMIENTO = '9999-12-31T00:00:00.000Z';

// hasta = null → pausa sin vencimiento (hasta #reanudar).
// paused_at marca el inicio de la pausa: extender una pausa en curso (otro echo) no lo mueve.
function pause(id, hasta, motivo) {
  const yaPausado = isPaused(getLead(id));
  updateLead(id, { paused_until: hasta || SIN_VENCIMIENTO, pause_reason: motivo, ...(yaPausado ? {} : { paused_at: now() }) });
  addEvent(id, 'paused', { hasta: hasta || null, motivo });
}

function resume(id, motivo) {
  updateLead(id, { paused_until: null, pause_reason: null });
  addEvent(id, 'resumed', { motivo });
}

function isPaused(lead) {
  return Boolean(lead && lead.paused_until && lead.paused_until > now());
}

// ¿Alguna persona escribió desde el número de Forja en este chat desde esa fecha?
function echoDesde(waId, desde) {
  return Boolean(db.get().prepare("SELECT 1 FROM messages WHERE wa_id = ? AND type = 'echo' AND created_at >= ? LIMIT 1").get(waId, desde || ''));
}

// ─── Estado suelto ───────────────────────────────────────────────────────────

function getEstado(clave) {
  return db.get().prepare('SELECT valor FROM estado WHERE clave = ?').get(clave)?.valor ?? null;
}

function setEstado(clave, valor) {
  db.get().prepare('INSERT INTO estado (clave, valor, updated_at) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at')
    .run(clave, valor, now());
}

// ─── Mensajes ────────────────────────────────────────────────────────────────

// Inserta un mensaje entrante. wa_message_id UNIQUE hace de filtro de duplicados:
// devuelve false si Meta reenvió un mensaje que ya teníamos.
function insertInbound({ waId, leadId, waMessageId, type, body = null, mediaId = null }) {
  const res = db.get().prepare(`
    INSERT INTO messages (id, wa_id, lead_id, direction, wa_message_id, type, body, media_id, status, created_at)
    VALUES (?, ?, ?, 'in', ?, ?, ?, ?, 'pendiente', ?)
    ON CONFLICT (wa_message_id) DO NOTHING
  `).run(uuid(), waId, leadId, waMessageId, type, body, mediaId, now());
  if (res.changes === 0) return false;
  updateLead(leadId, { last_inbound_at: now() });
  return true;
}

function pendingInbound(waId) {
  return db.get().prepare(`
    SELECT * FROM messages WHERE wa_id = ? AND direction = 'in' AND status = 'pendiente' ORDER BY created_at, rowid
  `).all(waId);
}

function waIdsWithPending() {
  return db.get().prepare("SELECT DISTINCT wa_id FROM messages WHERE direction = 'in' AND status = 'pendiente'").all().map((r) => r.wa_id);
}

function bumpAttempts(ids) {
  const stmt = db.get().prepare('UPDATE messages SET attempts = attempts + 1 WHERE id = ?');
  db.get().transaction(() => ids.forEach((id) => stmt.run(id)))();
}

// Conversación pausada: los mensajes del lead quedan en el historial pero el agente no responde.
function swallowPending(waId) {
  return db.get().prepare("UPDATE messages SET status = 'pausado', processed_at = ? WHERE wa_id = ? AND direction = 'in' AND status = 'pendiente'")
    .run(now(), waId).changes;
}

// Reinicio de pruebas: el número arranca de cero sin borrar nada. Los leads
// anteriores quedan cerrados, se crea uno nuevo y el historial que ve el
// agente empieza después de este punto.
function resetConversation(waId) {
  const conn = db.get();
  return conn.transaction(() => {
    const anterior = getCurrentLead(waId);
    conn.prepare("UPDATE messages SET status = 'procesado', processed_at = ? WHERE wa_id = ? AND direction = 'in' AND status = 'pendiente'").run(now(), waId);
    conn.prepare("UPDATE leads SET status = 'cerrado', updated_at = ? WHERE wa_id = ?").run(now(), waId);
    conn.prepare("UPDATE followups SET status = 'cancelled', reason = 'reinicio', updated_at = ? WHERE status IN ('pending') AND lead_id IN (SELECT id FROM leads WHERE wa_id = ?)").run(now(), waId);
    const desde = conn.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM messages WHERE wa_id = ?').get(waId).n;
    const nuevo = createLead(waId, { nombrePerfil: anterior?.nombre_perfil || null });
    addEvent(nuevo.id, 'conversation_reset', { desde_mensaje: desde, lead_anterior: anterior?.id || null });
    return nuevo;
  })();
}

function inicioHistorial(waId) {
  const row = db.get().prepare(`
    SELECT e.payload FROM lead_events e JOIN leads l ON l.id = e.lead_id
    WHERE l.wa_id = ? AND e.type = 'conversation_reset'
    ORDER BY e.rowid DESC LIMIT 1
  `).get(waId);
  return row ? JSON.parse(row.payload).desde_mensaje : 0;
}

// Últimos N mensajes de texto del número (entrantes y salientes), en orden.
function history(waId, limit = 40) {
  return db.get().prepare(`
    SELECT * FROM (
      SELECT rowid AS rid, * FROM messages
      WHERE wa_id = ? AND body IS NOT NULL AND rowid > ?
        AND NOT (direction = 'in' AND status = 'pendiente')
        AND NOT (direction = 'out' AND status IN ('fallido'))
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    ) ORDER BY created_at, rid
  `).all(waId, inicioHistorial(waId), limit);
}

// Cierra un turno de forma atómica: marca los entrantes como procesados y
// registra la respuesta saliente en estado 'enviando'. Si el proceso muere
// entre esto y el envío, al reiniciar no se vuelve a responder (sin duplicados).
function commitTurn({ waId, leadId, inboundIds, replyText }) {
  const conn = db.get();
  const outId = uuid();
  const ts = now();
  conn.transaction(() => {
    const mark = conn.prepare("UPDATE messages SET status = 'procesado', processed_at = ? WHERE id = ?");
    inboundIds.forEach((id) => mark.run(ts, id));
    if (replyText) {
      conn.prepare(`
        INSERT INTO messages (id, wa_id, lead_id, direction, type, body, status, created_at)
        VALUES (?, ?, ?, 'out', 'text', ?, 'enviando', ?)
      `).run(outId, waId, leadId, replyText, ts);
    }
  })();
  return replyText ? outId : null;
}

function insertOutbound({ waId, leadId, type = 'text', body, status = 'enviando', waMessageId = null }) {
  const id = uuid();
  db.get().prepare(`
    INSERT INTO messages (id, wa_id, lead_id, direction, wa_message_id, type, body, status, created_at)
    VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?)
  `).run(id, waId, leadId, waMessageId, type, body, status, now());
  return id;
}

// Mensaje que una persona escribió desde el número de Forja (echo de coexistencia).
// Devuelve false si ya lo teníamos: es un reenvío de Meta o un mensaje que mandó el propio agente.
function insertEcho({ waId, leadId, waMessageId, body }) {
  const res = db.get().prepare(`
    INSERT INTO messages (id, wa_id, lead_id, direction, wa_message_id, type, body, status, created_at)
    VALUES (?, ?, ?, 'out', ?, 'echo', ?, 'enviado', ?)
    ON CONFLICT (wa_message_id) DO NOTHING
  `).run(uuid(), waId, leadId, waMessageId, body, now());
  return res.changes === 1;
}

function markOutbound(id, status, waMessageId = null) {
  db.get().prepare('UPDATE messages SET status = ?, wa_message_id = COALESCE(?, wa_message_id) WHERE id = ?')
    .run(status, waMessageId, id);
}

const ORDEN_ESTADOS = { enviado: 1, entregado: 2, leido: 3 };

// Estados de entrega de Meta (sent/delivered/read/failed). No retrocede: un
// 'delivered' que llega tarde no pisa un 'read'.
function setDeliveryStatus(waMessageId, status) {
  const row = db.get().prepare("SELECT id, status FROM messages WHERE wa_message_id = ? AND direction = 'out'").get(waMessageId);
  if (!row) return;
  if (status !== 'fallido' && (ORDEN_ESTADOS[row.status] || 0) >= ORDEN_ESTADOS[status]) return;
  db.get().prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, row.id);
}

// Al arrancar: salientes que quedaron 'enviando' (el proceso murió en medio del
// envío). No se reenvían para no duplicar; quedan marcados para auditoría.
function markStuckOutbound() {
  return db.get().prepare("UPDATE messages SET status = 'desconocido' WHERE direction = 'out' AND status = 'enviando'").run().changes;
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

function addEvent(leadId, type, payload = null) {
  db.get().prepare('INSERT INTO lead_events (id, lead_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), leadId, type, payload == null ? null : JSON.stringify(payload), now());
}

function events(leadId) {
  return db.get().prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at, rowid').all(leadId)
    .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}

// ─── Derivaciones ────────────────────────────────────────────────────────────

const parseDerivacion = (d) => (d ? { ...d, datos: d.datos ? JSON.parse(d.datos) : null } : null);

// Registra un brief para enviar. Idempotente por (lead, clave): si el lead
// repite el pedido devuelve el brief original con creada = false.
// Un 'aviso' usa el mismo camino de entrega pero no cuenta como derivación del lead.
function createDerivacion({ leadId, tipo, clave, destino, texto, nota = null, datos = null }) {
  const conn = db.get();
  return conn.transaction(() => {
    const res = conn.prepare(`
      INSERT INTO derivaciones (id, lead_id, tipo, clave, destino, texto, nota, datos, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (lead_id, clave) DO NOTHING
    `).run(uuid(), leadId, tipo, clave, destino || null, texto, nota, datos ? JSON.stringify(datos) : null, now());
    const derivacion = parseDerivacion(conn.prepare('SELECT * FROM derivaciones WHERE lead_id = ? AND clave = ?').get(leadId, clave));
    if (res.changes === 1 && tipo !== 'aviso') {
      markDerived(leadId);
      addEvent(leadId, 'derived', { tipo, clave, derivacion_id: derivacion.id });
    }
    return { creada: res.changes === 1, derivacion };
  })();
}

// Derivaciones del lead (sin los avisos internos).
function derivacionesDe(leadId) {
  return db.get().prepare("SELECT * FROM derivaciones WHERE lead_id = ? AND tipo != 'aviso' ORDER BY created_at, rowid").all(leadId).map(parseDerivacion);
}

function getDerivacion(id) {
  return parseDerivacion(db.get().prepare('SELECT * FROM derivaciones WHERE id = ?').get(id));
}

// Briefs que no salieron y hay que reintentar: fallaron (menos de maxIntentos
// veces) o quedaron pendientes desde antes de `creadosAntesDe`. Los recién
// creados no se tocan: los está enviando el turno que los generó.
function derivacionesPorReintentar(maxIntentos, creadosAntesDe) {
  return db.get().prepare(`
    SELECT * FROM derivaciones
    WHERE attempts < ? AND (status = 'fallido' OR (status = 'pendiente' AND created_at < ?))
    ORDER BY created_at, rowid
  `).all(maxIntentos, creadosAntesDe).map(parseDerivacion);
}

// Todo lo que Alejandro todavía no recibió en limpio: pendientes, fallidos y
// los que solo salieron por plantilla (avisado). Se entregan cuando escribe.
function derivacionesSinEntregar() {
  return db.get().prepare("SELECT * FROM derivaciones WHERE status IN ('pendiente', 'fallido', 'avisado') ORDER BY created_at, rowid").all().map(parseDerivacion);
}

// Toma el brief para enviarlo. Solo uno gana (el turno, el reintento o el
// toque del botón): es lo que evita que un brief salga dos veces.
function claimDerivacion(id) {
  return db.get().prepare("UPDATE derivaciones SET status = 'enviando', attempts = attempts + 1 WHERE id = ? AND status IN ('pendiente', 'fallido', 'avisado')")
    .run(id).changes === 1;
}

// 'avisado' = salió la plantilla; el brief limpio se entrega cuando Alejandro responde.
function markDerivacion(id, status, error = null) {
  const ts = now();
  db.get().prepare(`
    UPDATE derivaciones SET status = ?, error = ?,
      sent_at = CASE WHEN ? = 'enviado' THEN ? ELSE sent_at END,
      avisado_at = CASE WHEN ? = 'avisado' THEN COALESCE(avisado_at, ?) ELSE avisado_at END
    WHERE id = ?
  `).run(status, error, status, ts, status, ts, id);
}

// Al arrancar: briefs que quedaron a medio enviar. Se reintentan: es preferible
// que a Alejandro le llegue un brief repetido a que se pierda un lead.
function releaseStuckDerivaciones() {
  return db.get().prepare("UPDATE derivaciones SET status = 'fallido', error = 'corte durante el envío' WHERE status = 'enviando'").run().changes;
}

// ─── Seguimiento ─────────────────────────────────────────────────────────────

function getFollowup(leadId) {
  return db.get().prepare('SELECT * FROM followups WHERE lead_id = ?').get(leadId) || null;
}

// Programa (o corre) el próximo toque de seguimiento del lead. Un lead tiene
// una sola fila: si ya recibió todos los toques, falló o se canceló en forma
// definitiva, no se vuelve a armar. No toca `step` (los toques ya enviados).
function armFollowup(leadId, dueAt, anchorAt) {
  const ts = now();
  const res = db.get().prepare(`
    INSERT INTO followups (id, lead_id, due_at, anchor_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (lead_id) DO UPDATE SET due_at = excluded.due_at, anchor_at = excluded.anchor_at, status = 'pending', reason = NULL, updated_at = excluded.updated_at
    WHERE followups.status = 'pending' OR (followups.status = 'cancelled' AND followups.reason = 'lead_escribio')
  `).run(uuid(), leadId, dueAt, anchorAt, ts, ts);
  return res.changes === 1;
}

// Un toque salió bien. Si queda otro configurado (proximoDueAt), la fila vuelve
// a 'pending' para ese; si no, queda 'sent' para siempre.
function advanceFollowup(id, proximoDueAt = null) {
  const ts = now();
  db.get().prepare("UPDATE followups SET step = step + 1, status = ?, due_at = COALESCE(?, due_at), reason = NULL, sent_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
    .run(proximoDueAt ? 'pending' : 'sent', proximoDueAt, ts, ts, id);
}

function getFollowupById(id) {
  return db.get().prepare('SELECT * FROM followups WHERE id = ?').get(id) || null;
}

// motivo 'lead_escribio' se puede volver a armar; cualquier otro es definitivo.
function cancelFollowup(leadId, motivo) {
  const res = db.get().prepare(`
    UPDATE followups SET status = 'cancelled', reason = ?, updated_at = ?
    WHERE lead_id = ? AND (status = 'pending' OR (status = 'cancelled' AND reason = 'lead_escribio' AND ? != 'lead_escribio'))
  `).run(motivo, now(), leadId, motivo);
  return res.changes === 1;
}

function dueFollowups(leadId = null) {
  return leadId
    ? db.get().prepare("SELECT * FROM followups WHERE lead_id = ? AND status = 'pending' AND due_at <= ?").all(leadId, now())
    : db.get().prepare("SELECT * FROM followups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at").all(now());
}

// Toma el seguimiento para enviarlo. Solo uno gana: es lo que garantiza un único envío.
function claimFollowup(id) {
  return db.get().prepare("UPDATE followups SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(now(), id).changes === 1;
}

function setFollowup(id, status, reason = null) {
  db.get().prepare("UPDATE followups SET status = ?, reason = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ? WHERE id = ?")
    .run(status, reason, status, now(), now(), id);
}

module.exports = {
  getCurrentLead, getLead, createLead, captureInbound, updateLead, mergeDatos, markDerived, findLeadByNumber,
  pause, resume, isPaused, echoDesde, getEstado, setEstado,
  insertInbound, pendingInbound, waIdsWithPending, bumpAttempts, swallowPending, history, commitTurn, resetConversation,
  insertOutbound, insertEcho, markOutbound, setDeliveryStatus, markStuckOutbound,
  addEvent, events,
  createDerivacion, getDerivacion, derivacionesDe, derivacionesPorReintentar, derivacionesSinEntregar, claimDerivacion, markDerivacion, releaseStuckDerivaciones,
  getFollowup, getFollowupById, armFollowup, advanceFollowup, cancelFollowup, dueFollowups, claimFollowup, setFollowup,
};
