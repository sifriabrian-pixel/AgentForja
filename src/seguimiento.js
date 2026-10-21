// Seguimiento a los leads que no avanzaron (spec §8).
//
// Cada respuesta del agente a un lead sin derivar programa (o corre) su
// seguimiento. FOLLOWUP_DAYS es la lista de toques (hoy uno solo, [5]): cada
// lead recibe como mucho esa cantidad de mensajes, nunca más. Si el lead
// escribe se cancela, y se vuelve a programar con la respuesta siguiente.
//
// Este archivo decide; enviar es trabajo del adapter (agent.js) o del test.
const config = require('../config/forja');
const clock = require('./clock');
const repo = require('./repo');

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

function horaLocal(fecha = clock.date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(fecha));
}

// "Buenos días" / "Buenas tardes" / "Buenas noches" según la hora de Argentina.
function saludo(fecha = clock.date()) {
  const h = horaLocal(fecha);
  if (h >= 6 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

// Si el lead consultó por una unidad (recibió su ficha), el mensaje la retoma;
// si no, es la frase de Alejandro ("¿tenés alguna búsqueda activa…?").
function textoSeguimiento(lead = null) {
  const base = lead?.datos?.propiedad_id ? config.MSG_SEGUIMIENTO_FICHA : config.MSG_SEGUIMIENTO;
  return base.replace('{saludo}', saludo()).replace('{identidad}', config.AGENT_IDENTITY);
}

// A quién no se le hace seguimiento.
function motivoSinSeguimiento(lead) {
  if (lead.derived_at) return 'derivado';
  if (lead.datos.colega) return 'colega';
  if (lead.datos.no_contactar) return 'no_contactar';
  if (lead.status === 'cerrado') return 'cerrado';
  return null;
}

const venceEn = (anchorAt, dias) => new Date(new Date(anchorAt).getTime() + dias * DIA).toISOString();

// Programa el próximo toque: FOLLOWUP_DAYS[toques ya enviados] días desde ahora
// (ahora = la respuesta del agente). Si ya recibió todos, no programa nada.
function programar(lead, store = repo) {
  if (motivoSinSeguimiento(lead)) return false;
  const dias = config.FOLLOWUP_DAYS;
  const enviados = store.getFollowup(lead.id)?.step || 0;
  if (enviados >= dias.length) return false;
  const ancla = clock.nowISO();
  return store.armFollowup(lead.id, venceEn(ancla, dias[enviados]), ancla);
}

// Después de enviar un toque: cuándo vence el siguiente (contado desde la misma
// respuesta del agente), o null si era el último.
function proximoVencimiento(followup) {
  const dias = config.FOLLOWUP_DAYS;
  const siguiente = followup.step + 1;
  if (siguiente >= dias.length) return null;
  return venceEn(followup.anchor_at || followup.created_at, dias[siguiente]);
}

// Qué hacer con un seguimiento que ya venció:
//   { accion: 'cancelar', motivo }
//   { accion: 'esperar', motivo }          se vuelve a mirar en la próxima pasada
//   { accion: 'enviar', via: 'texto' | 'plantilla', texto, plantilla?, idioma?, params? }
function decidir(followup, lead, store = repo) {
  const sin = motivoSinSeguimiento(lead);
  if (sin) return { accion: 'cancelar', motivo: sin };
  if (store.isPaused(lead)) return { accion: 'cancelar', motivo: 'intervencion_humana' };

  const ahora = clock.date();
  if (ahora - new Date(followup.due_at) > config.seguimiento.vencimientoDias * DIA) return { accion: 'cancelar', motivo: 'vencido' };

  const { desde, hasta } = config.seguimiento.franja;
  const h = horaLocal(ahora);
  if (h < desde || h >= hasta) return { accion: 'esperar', motivo: 'fuera_de_franja' };

  const texto = textoSeguimiento(lead);
  const enVentana = lead.last_inbound_at && ahora - new Date(lead.last_inbound_at) < DIA;
  if (enVentana) return { accion: 'enviar', via: 'texto', texto };

  // Fuera de la ventana de 24 hs Meta solo acepta plantillas aprobadas. Sin
  // plantilla configurada no se manda nada (nunca texto libre).
  const plantilla = config.FOLLOWUP_TEMPLATE_NAME;
  if (!plantilla) return { accion: 'esperar', motivo: 'sin_plantilla' };
  // Lo que queda en el historial es lo que el lead realmente recibe: el texto
  // de la plantilla aprobada (docs/plantillas-meta.md), no el mensaje con saludo.
  const conSaludo = config.seguimiento.plantillaConSaludo;
  return {
    accion: 'enviar', via: 'plantilla', plantilla, idioma: config.seguimiento.idioma,
    texto: conSaludo ? texto : config.MSG_SEGUIMIENTO_PLANTILLA.replace('{identidad}', config.AGENT_IDENTITY),
    params: conSaludo ? { 1: saludo() } : {},
  };
}

module.exports = { saludo, horaLocal, textoSeguimiento, programar, proximoVencimiento, decidir, motivoSinSeguimiento };
