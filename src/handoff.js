// Entrega de briefs y avisos a HANDOFF_WHATSAPP (Alejandro), esquema híbrido.
//
// WhatsApp solo deja mandar texto libre a quien escribió en las últimas 24 hs.
//   - Ventana abierta  → el brief sale como texto libre, limpio, listo para
//     reenviar; el origen y las notas internas van en un segundo mensaje.
//   - Ventana cerrada  → sale la plantilla HANDOFF_TEMPLATE_NAME con el brief
//     como variable y un botón "Recibir para reenviar". El brief queda guardado
//     ('avisado') hasta que Alejandro toque el botón o escriba cualquier cosa.
//   - Cuando Alejandro escribe → se le mandan en limpio todos los pendientes.
//
// Cada envío se toma con un claim en la base: un brief no sale dos veces
// aunque toque el botón dos veces o el reintento corra a la vez.
//
// No conoce WhatsApp: recibe un `sender` { sendMessage(to, texto),
// sendTemplate(to, plantilla, idioma, params) }. En producción es
// src/whatsapp.js; en el adapter de test, uno que solo registra.
const config = require('../config/forja');
const repo = require('./repo');
const clock = require('./clock');

const CLAVE_ENTRANTE = 'handoff_last_inbound_at';
const HORA = 60 * 60 * 1000;
// Margen para no mandar texto libre justo cuando la ventana se está cerrando.
const VENTANA_MS = 24 * HORA - 10 * 60 * 1000;
const MAX_VARIABLE = 900; // el cuerpo de una plantilla admite 1024 caracteres en total

// Alejandro escribió (un mensaje, un comando o el toque del botón).
function registrarEntrante() {
  repo.setEstado(CLAVE_ENTRANTE, clock.nowISO());
}

function ventanaAbierta() {
  const ultimo = repo.getEstado(CLAVE_ENTRANTE);
  return Boolean(ultimo) && clock.date() - new Date(ultimo) < VENTANA_MS;
}

// Una variable de plantilla no admite saltos de línea, tabulaciones ni muchos
// espacios seguidos. El brief ya es de una línea; esto lo garantiza.
function variablePlantilla(texto) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim();
  return limpio.length > MAX_VARIABLE ? `${limpio.slice(0, MAX_VARIABLE - 1)}…` : limpio;
}

const corto = (e) => String(e?.message || e).slice(0, 300);

// Manda el brief en limpio y, aparte, la nota. Si la nota falla el brief no se repite.
async function enviarLimpio(d, to, sender) {
  if (!repo.claimDerivacion(d.id)) return 'tomado';
  try {
    await sender.sendMessage(to, d.texto);
  } catch (e) {
    repo.markDerivacion(d.id, 'fallido', corto(e));
    repo.addEvent(d.lead_id, 'handoff_notify_failed', { derivacion_id: d.id, via: 'texto', error: corto(e) });
    return 'fallido';
  }
  repo.markDerivacion(d.id, 'enviado');
  repo.addEvent(d.lead_id, 'handoff_notified', { derivacion_id: d.id, via: 'texto' });
  if (d.nota) {
    try {
      await sender.sendMessage(to, d.nota);
    } catch (e) {
      repo.addEvent(d.lead_id, 'handoff_note_failed', { derivacion_id: d.id, error: corto(e) });
    }
  }
  return 'enviado';
}

async function enviarPlantilla(d, to, sender) {
  if (!repo.claimDerivacion(d.id)) return 'tomado';
  try {
    await sender.sendTemplate(to, config.HANDOFF_TEMPLATE_NAME, config.handoff.idioma, { 1: variablePlantilla(d.texto) });
  } catch (e) {
    repo.markDerivacion(d.id, 'fallido', corto(e));
    repo.addEvent(d.lead_id, 'handoff_notify_failed', { derivacion_id: d.id, via: 'plantilla', error: corto(e) });
    return 'fallido';
  }
  repo.markDerivacion(d.id, 'avisado');
  repo.addEvent(d.lead_id, 'handoff_template_sent', { derivacion_id: d.id });
  return 'avisado';
}

// Entrega un brief según el estado de la ventana. Devuelve qué pasó:
//   'enviado'        salió en limpio (ventana abierta)
//   'avisado'        salió la plantilla; espera el toque de Alejandro
//   'esperando'      la plantilla ya había salido; sigue esperando
//   'sin_plantilla'  ventana cerrada y sin HANDOFF_TEMPLATE_NAME: queda guardado
//   'sin_destino'    falta HANDOFF_WHATSAPP
//   'fallido'        falló el envío (se reintenta) · 'tomado' lo está enviando otro
async function entregar(derivacionId, sender) {
  const to = config.HANDOFF_WHATSAPP;
  if (!to) return 'sin_destino';
  const d = repo.getDerivacion(derivacionId);
  if (!d || d.status === 'enviado' || d.status === 'enviando') return 'tomado';

  if (ventanaAbierta()) return enviarLimpio(d, to, sender);

  // Ventana cerrada. La plantilla sale una sola vez por brief.
  if (d.avisado_at) {
    if (d.status !== 'avisado') repo.markDerivacion(d.id, 'avisado');
    return 'esperando';
  }
  if (!config.HANDOFF_TEMPLATE_NAME) {
    if (!repo.events(d.lead_id).some((e) => e.type === 'handoff_sin_plantilla' && e.payload?.derivacion_id === d.id)) {
      repo.addEvent(d.lead_id, 'handoff_sin_plantilla', { derivacion_id: d.id });
      console.error('[derivacion] Alejandro tiene la ventana de 24 hs cerrada y no hay HANDOFF_TEMPLATE_NAME: el brief queda guardado hasta que escriba al número');
    }
    return 'sin_plantilla';
  }
  return enviarPlantilla(d, to, sender);
}

// Alejandro escribió o tocó el botón: se le mandan en limpio todos los briefs
// que todavía no recibió así. Devuelve cuántos salieron.
async function alEscribirAlejandro(sender) {
  registrarEntrante();
  const to = config.HANDOFF_WHATSAPP;
  let entregados = 0;
  for (const d of repo.derivacionesSinEntregar()) {
    if (await enviarLimpio(d, to, sender) === 'enviado') entregados += 1;
  }
  return entregados;
}

// Reintento periódico de lo que falló o quedó sin salir.
async function reintentar(sender, { maxIntentos = 5, creadosAntesDe } = {}) {
  let n = 0;
  for (const d of repo.derivacionesPorReintentar(maxIntentos, creadosAntesDe)) {
    const r = await entregar(d.id, sender);
    if (r === 'enviado' || r === 'avisado') n += 1;
  }
  return n;
}

module.exports = { entregar, alEscribirAlejandro, reintentar, registrarEntrante, ventanaAbierta, variablePlantilla };
