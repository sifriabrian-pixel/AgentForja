// Procesa el payload del webhook de WhatsApp Cloud API.
const repo = require('./repo');
const agent = require('./agent');
const core = require('./core');
const config = require('../config/forja');
const { mismoNumero } = require('./numeros');

const ESTADOS_WA = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' };
const IGNORAR = new Set(['reaction', 'system', 'ephemeral']);

const esHandoff = (waId) => Boolean(config.HANDOFF_WHATSAPP) && mismoNumero(waId, config.HANDOFF_WHATSAPP);

// Mensajes de HANDOFF_WHATSAPP (Alejandro). No es un lead: no se le responde
// como tal. Cualquier mensaje suyo (también el toque del botón "Recibir para
// reenviar") abre la ventana de 24 hs y dispara la entrega de los briefs
// pendientes. Además se atienden los comandos #pausa / #reanudar.
function handleInterno(msg) {
  agent.handoffInbound();
  const texto = msg.type === 'text' ? msg.text?.body || '' : '';
  const { esComando, reply } = core.command(texto);
  if (!esComando) return;
  console.log(`[comandos] ${msg.from}: ${texto.trim()}`);
  agent.replyCommand(msg.from, reply);
}

// Echoes: mensajes que una persona escribió desde la app de WhatsApp Business
// con el mismo número (coexistencia). Pausan al agente en esa conversación.
function handleEchoes(value) {
  for (const echo of value.message_echoes || []) {
    if (!echo.to) continue;
    const texto = echo.type === 'text' ? echo.text?.body : `[${echo.type}]`;
    const { pausado } = core.registerEcho({ conversationId: echo.to, messageId: echo.id, text: texto });
    if (pausado) console.log(`[pausa] Intervino una persona en ${echo.to}: agente en pausa ${config.HUMAN_TAKEOVER_HOURS} hs`);
  }
}

// Devuelve la lista de wa_id con mensajes nuevos (para tests).
// Webhook de Kapso con su formato propio (el único que admite el sandbox de
// Kapso): { message, conversation, phone_number_id }, o un lote
// { batch: true, data: [...] }. Se traduce al sobre de Meta para que el resto
// del agente no cambie. Solo interesan los mensajes entrantes.
function kapsoAMeta(payload) {
  const eventos = payload.batch ? payload.data || [] : [payload];
  const mensajes = [];
  const contactos = [];
  for (const ev of eventos) {
    const m = ev?.message;
    if (!m || m.kapso?.direction !== 'inbound') continue;
    const from = m.from || ev.conversation?.phone_number;
    if (!from) continue;
    const { kapso, ...meta } = m;
    mensajes.push({ ...meta, from: String(from).replace(/\D/g, '') });
    contactos.push({ wa_id: String(from).replace(/\D/g, ''), profile: { name: ev.conversation?.contact_name || null } });
  }
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: contactos, messages: mensajes } }] }] };
}

const esFormatoKapso = (p) => !p?.entry && (p?.message || p?.batch);

function handlePayload(payload) {
  if (esFormatoKapso(payload)) payload = kapsoAMeta(payload);
  const numeros = new Set();
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      if (change.field === 'smb_message_echoes' || value.message_echoes) {
        handleEchoes(value);
        continue;
      }

      const perfiles = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || null]));

      for (const msg of value.messages || []) {
        const waId = msg.from;
        if (!waId) continue;
        if (esHandoff(waId)) {
          handleInterno(msg);
          continue;
        }

        const comando = config.pruebas?.reiniciar;
        if (comando && msg.type === 'text' && (msg.text?.body || '').trim().toLowerCase() === comando) {
          agent.reset(waId).catch((e) => console.error(`[pruebas] Error reiniciando ${waId}:`, e));
          continue;
        }

        // 1. Origen del lead: se guarda ANTES de mirar el tipo de mensaje y
        //    antes de cualquier llamada al LLM. Si el primer mensaje es un
        //    audio o un sticker, el anuncio igual queda registrado.
        // 2. Historial + filtro de duplicados (wa_message_id UNIQUE).
        const ignorado = IGNORAR.has(msg.type);
        const mediaId = ignorado ? null : agent.mediaIdOf(msg);
        const { nuevo } = core.ingest({
          conversationId: waId,
          from: waId,
          text: ignorado ? null : agent.describeInbound(msg),
          messageId: msg.id,
          type: msg.type,
          attachments: mediaId ? [{ type: msg.type, mediaId }] : [],
          metadata: { referral: msg.referral || null, profileName: perfiles[waId] || null },
        });
        if (ignorado) continue;
        if (!nuevo) {
          console.log(`[webhook] Mensaje duplicado ignorado: ${msg.id}`);
          continue;
        }
        numeros.add(waId);
      }

      for (const st of value.statuses || []) {
        const estado = ESTADOS_WA[st.status];
        if (estado && st.id) repo.setDeliveryStatus(st.id, estado);
      }
    }
  }

  // 3. Procesar (de a un mensaje por número; en segundo plano).
  for (const waId of numeros) agent.kick(waId);
  return [...numeros];
}

module.exports = { handlePayload, kapsoAMeta };
