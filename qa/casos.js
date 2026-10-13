// Los casos de prueba: los 15 de la spec (§11) más los 5 que sumó el cliente
// (16 a 20), como conversaciones guionadas.
//
// Cada caso: pasos del lead (o de Alejandro / del reloj) y chequeos
// determinísticos sobre lo que el agente dijo e hizo. Los corre qa/run.js con
// el Claude real sobre el adapter de test (nada se envía por WhatsApp).
//
// Pasos:  { lead: 'texto', metadata? }   mensaje del lead
//         { echo: 'texto' }              Alejandro escribe a mano desde el número de Forja
//         { alejandro: 'toca el botón' } Alejandro escribe o toca "Recibir para reenviar"
//         { dias: 5 }                    pasan N días y corre el job de seguimiento
//         { hora: 'ISO' }                fija la hora del resto del caso
// ctx:    { respuestas: [texto del agente por paso], todas: [todos sus mensajes],
//           acciones, briefs(tipo), briefsAlPaso: [cuántos briefs había después de cada paso],
//           aAlejandro: [{ via: 'plantilla' | 'texto', texto }] lo que le llegó a Alejandro,
//           recibidosAlPaso: [cuántos mensajes le habían llegado después de cada paso],
//           state, eventos }
// Cada caso arranca con la ventana de 24 hs de Alejandro cerrada.
const config = require('../config/forja');

const WEB = 'https://www.forjapropiedades.com/propiedades';
const LINK = {
  puertoNorte: `${WEB}/alquiler-av-candido-carballo-al-200`,
  kentucky: `${WEB}/venta-casa-en-barrio-kentucky-club-de-campo`,
  ayacucho: `${WEB}/venta-piso-exclusivo-de-3-dormitorios-ayacucho-1300`,
  aurea: `${WEB}/alquiler-aurea-fisherton-2-dormitorios-premium-schweitzer-8700`,
  temporario: `${WEB}/alquiler-departamento-de-2-dormitorios-juana-manso-400-puerto-madero`,
  reservada: `${WEB}/venta-apto-credito-casa-en-una-sola-planta-con-3-dormitorios-pileta-y-jardin-funes-hills-miraflores`,
};

const c = (ok, desc) => ({ ok: Boolean(ok), desc });
const alguna = (textos, re) => textos.some((t) => re.test(t));
const cuantas = (textos, re) => textos.filter((t) => re.test(t)).length;
const QUE_BUSCAS = /qu[eé] est[aá]s buscando/i;
const PREGUNTA_PRESUPUESTO = /presupuesto[^.]*\?|\?[^.]*presupuesto/i;
const CONDICIONES = /comisi[oó]n|honorario|\d\s?%|compartimos|no compartimos/i;

const VISITA_AYACUCHO = [
  { lead: `Hola, me interesa este depto ${LINK.ayacucho}` },
  { lead: 'Soy Carla. Me gusta, quiero ir a verlo' },
  { lead: 'Puedo martes o jueves después de las 17' },
];

module.exports = [
  {
    id: 1,
    nombre: 'Depto de Puerto Norte: le gusta y pide visitar',
    pasos: [
      { lead: `Hola, me interesa el depto de Puerto Norte ${LINK.puertoNorte}` },
      { lead: 'Soy Carla. ¿Tiene cochera?' },
      { lead: 'Me gusta, quiero ir a verlo' },
      { lead: 'Puedo martes o jueves después de las 17' },
    ],
    checks: (x) => [
      c(/buen[oa]s (d[ií]as|tardes|noches)/i.test(x.respuestas[0]) && /nombre/i.test(x.respuestas[0]), 'saluda según la hora y pide el nombre'),
      c(/s[ií]|cochera/i.test(x.respuestas[1]), 'responde la cochera con el dato de Tokko'),
      c(alguna(x.todas, /d[ií]as y horarios/i), 'pide disponibilidad antes de derivar'),
      c(x.briefs('visita').length === 1 && /^\(VISITA ALQUILER\).*11170708/.test(x.briefs('visita')[0]), 'deriva la visita con el formato §5.2'),
      c(/martes/i.test(x.briefs('visita')[0] || ''), 'el brief lleva la disponibilidad'),
      c(x.todas[x.todas.length - 1].includes(config.MSG_VISITA_DERIVADA), 'le dice al lead la frase de Alejandro'),
    ],
  },
  {
    id: 2,
    nombre: 'Casa de USD 980k: "se me va de presupuesto"',
    pasos: [
      { lead: `Hola, quería info de esta casa ${LINK.kentucky}` },
      { lead: 'Soy Martín. Uh, se me va de presupuesto' },
      { lead: 'Busco una casa de 3 dormitorios en Funes o Fisherton, para comprar' },
      { lead: 'Que tenga pileta y cochera' },
      { lead: 'Hasta 400 mil dólares, de contado' },
      { lead: 'Eso es todo, gracias' },
    ],
    checks: (x) => [
      c(QUE_BUSCAS.test(x.respuestas[1]), 'pregunta "¿qué estás buscando?"'),
      c(x.briefs('busqueda').length === 1 && /^\(BÚSQUEDA VENTA\) /.test(x.briefs('busqueda')[0]), 'deriva la búsqueda con el formato §5.1'),
      c(/Funes/i.test(x.briefs('busqueda')[0] || '') && /pileta/i.test(x.briefs('busqueda')[0] || ''), 'el brief lleva zona y excluyentes'),
      c(/Origen: consultó por Casa en Barrio Kentucky/.test(x.briefs('busqueda')[0] || ''), 'el origen es la unidad consultada'),
      c(!alguna(x.todas, /descuento|negocia|rebaja/i), 'no insinúa que el precio se negocia'),
    ],
  },
  {
    id: 3,
    nombre: 'Esquiva el presupuesto ("depende de lo que haya")',
    pasos: [
      { lead: 'Hola, busco un departamento de 2 dormitorios en Fisherton para comprar' },
      { lead: 'Soy Paula' },
      { lead: 'Que tenga balcón' },
      { lead: 'Depende de lo que haya' },
      { lead: 'No sé, lo vemos después' },
    ],
    checks: (x) => [
      c(cuantas(x.todas, PREGUNTA_PRESUPUESTO) <= 1, `pregunta el presupuesto como mucho una vez (lo hizo ${cuantas(x.todas, PREGUNTA_PRESUPUESTO)})`),
      c(x.briefs('busqueda').length === 1, 'deriva la búsqueda igual'),
      c(/Presupuesto: a confirmar/.test(x.briefs('busqueda')[0] || ''), 'el brief dice "Presupuesto: a confirmar"'),
    ],
  },
  {
    id: 4,
    nombre: 'Declina: "no, gracias, solo miraba"',
    pasos: [
      { lead: `Hola, vi este depto ${LINK.ayacucho}` },
      { lead: 'Soy Diego. No, es muy caro para mí' },
      { lead: 'No, gracias, solo miraba' },
    ],
    checks: (x) => [
      c(x.acciones.length === 0, 'no deriva nada'),
      c(x.state.followup?.status === 'pending', 'queda el seguimiento programado'),
      c(x.eventos.some((e) => e.type === 'seguimiento_pedido'), 'el agente llamó a programar_seguimiento'),
      c(cuantas(x.respuestas.slice(2), /\?/) === 0, 'cierra sin seguir preguntando'),
    ],
  },
  {
    id: 5,
    nombre: 'Responde al seguimiento: "sí, busco 2 dorm en Fisherton"',
    pasos: [
      { lead: `Hola, vi este depto ${LINK.ayacucho}` },
      { lead: 'Soy Diego. No, gracias, solo miraba' },
      { dias: 5 },
      { lead: 'Sí, busco un departamento de 2 dormitorios en Fisherton, para comprar' },
      { lead: 'Sin nada excluyente' },
      { lead: 'Todavía no tengo definido el presupuesto' },
    ],
    checks: (x) => [
      c(/b[uú]squeda activa/i.test(x.respuestas[2] || ''), 'a los 5 días sale el mensaje de seguimiento'),
      c(x.briefs('busqueda').length === 1 && /2 dormitorios/.test(x.briefs('busqueda')[0]) && /Fisherton/.test(x.briefs('busqueda')[0]), 'entra en modo búsqueda y deriva'),
      c(x.acciones.filter((a) => a.type === 'send_followup').length === 1, 'un solo seguimiento'),
    ],
  },
  {
    id: 6,
    nombre: 'Colega: "¿comparten 3 y 3?"',
    pasos: [{ lead: 'Hola, soy de Inmobiliaria Pérez, ¿comparten 3 y 3?' }],
    checks: (x) => [
      c(x.briefs('humano').length === 1 && /^\(ATENCIÓN HUMANA - colega\)/.test(x.briefs('humano')[0]), 'deriva a humano con motivo colega'),
      c(!alguna(x.todas, CONDICIONES), 'no responde condiciones comerciales'),
      c(x.state.paused, 'el agente queda en pausa'),
      c(!x.state.followup || x.state.followup.status !== 'pending', 'sin seguimiento para colegas'),
    ],
  },
  {
    id: 7,
    nombre: 'Legal / técnica: "¿Tiene escritura? ¿Se puede ampliar el living?"',
    pasos: [
      { lead: `Hola, consulto por ${LINK.ayacucho}` },
      { lead: 'Soy Leo. ¿Tiene escritura? ¿Se puede ampliar el living?' },
    ],
    checks: (x) => [
      c(x.briefs('humano').length === 1, 'deriva a humano'),
      c(!/tiene escritura|s[ií], se puede|no se puede|est[aá] escriturad/i.test(x.respuestas[1]), 'no responde el tema legal ni técnico'),
      c(/asesor/i.test(x.respuestas[1]), 'avisa que lo ve un asesor'),
    ],
  },
  {
    id: 8,
    nombre: 'Unidad reservada',
    pasos: [{ lead: `Hola, ¿sigue disponible? ${LINK.reservada}` }],
    checks: (x) => [
      c(/reservad|no est[aá] disponible|ya no est[aá]|no se encuentra disponible/i.test(x.respuestas[0]), 'avisa que no está disponible'),
      c(QUE_BUSCAS.test(x.respuestas[0]) || /buscando|b[uú]squeda/i.test(x.respuestas[0]), 'ofrece búsqueda'),
      c(x.briefs('visita').length === 0, 'no deriva visita'),
    ],
  },
  {
    id: 9,
    nombre: 'Llega sin unidad y con casi todos los datos',
    pasos: [
      { lead: 'Hola, busco monoambiente cerca de facultades para invertir, 40 mil' },
      { lead: 'Soy María Angélica' },
      { lead: 'Que tenga ascensor si es piso alto y más de 30 m2. Son dólares, de contado' },
      { lead: 'Nada más' },
    ],
    checks: (x) => [
      c(!alguna(x.todas, /en qu[eé] zona/i), 'no vuelve a preguntar la zona'),
      c(!alguna(x.todas, /cu[aá]ntos dormitorios/i), 'no pregunta dormitorios (es un monoambiente)'),
      c(cuantas(x.todas, /ten[eé]s un presupuesto/i) === 0, 'no pregunta el presupuesto que ya dio'),
      c(x.briefs('busqueda').length === 1 && /^\(BÚSQUEDA VENTA\) monoambiente/i.test(x.briefs('busqueda')[0]), 'deriva la búsqueda'),
      c(/inversi[oó]n/i.test(x.briefs('busqueda')[0] || '') && /40/.test(x.briefs('busqueda')[0] || ''), 'el brief lleva destino y presupuesto'),
    ],
  },
  {
    id: 10,
    nombre: 'Pide un dato que no está en Tokko (expensas)',
    pasos: [
      { lead: `Hola, consulto por ${LINK.ayacucho}` },
      { lead: 'Soy Flor. ¿Cuánto paga de expensas?' },
    ],
    checks: (x) => [
      c(!/\$\s?\d|\d{2,3}\.\d{3}|\d+ mil/i.test(x.respuestas[1]), 'no inventa un monto de expensas'),
      c(/asesor/i.test(x.respuestas[1]), 'ofrece confirmarlo con un asesor'),
    ],
  },
  {
    id: 11,
    nombre: 'Escribe a las 23 hs',
    pasos: [{ hora: '2026-10-13T02:00:00.000Z' }, { lead: `Hola, ¿me pasás info? ${LINK.ayacucho}` }],
    checks: (x) => [
      c(/buenas noches/i.test(x.respuestas[1]), 'saluda "Buenas noches"'),
      c(/300\.000|3 dormitorios|ayacucho/i.test(x.respuestas[1]) || /nombre/i.test(x.respuestas[1]), 'atiende normal'),
      c(!/ma[ñn]ana te|en \d+ (hora|minuto)|en un rato|dentro de/i.test(x.respuestas[1]), 'no promete tiempos'),
    ],
  },
  {
    id: 12,
    nombre: 'Repite "quiero visitar" después de derivado',
    pasos: [...VISITA_AYACUCHO, { lead: 'Quiero visitar' }, { lead: 'Hola? quiero visitar el depto' }],
    checks: (x) => [
      c(x.briefs('visita').length === 1, `una sola derivación de visita (hubo ${x.briefs('visita').length})`),
      c(x.respuestas[3] && x.respuestas[4], 'igual le responde al lead'),
    ],
  },
  {
    id: 13,
    // Cambió con las respuestas del cliente: Forja no hace búsquedas de alquiler.
    nombre: 'Busca alquilar sin unidad puntual (con mascota): zona y fechas → a humano',
    pasos: [
      { lead: 'Hola, busco alquilar una casa de 3 dormitorios. Tengo un perro' },
      { lead: 'Soy Vero' },
      { lead: 'En Funes, desde marzo, por un año' },
      { lead: 'Eso es todo' },
    ],
    checks: (x) => [
      c(x.briefs('busqueda').length === 0, 'no arma brief de búsqueda'),
      c(x.briefs('humano').length === 1 && /^\(ATENCIÓN HUMANA - alquiler\)/.test(x.briefs('humano')[0]), 'deriva a humano con motivo alquiler'),
      c(/Funes/i.test(x.briefs('humano')[0] || '') && /marzo/i.test(x.briefs('humano')[0] || ''), 'el resumen lleva zona y fechas'),
      c(!alguna(x.todas, /garant[ií]a/i) && !alguna(x.todas, /mascota[^.]*\?/i), 'no pregunta garantía ni mascotas'),
      c(!alguna(x.todas, PREGUNTA_PRESUPUESTO), 'no pregunta presupuesto'),
    ],
  },
  {
    id: 14,
    nombre: 'Pide hablar con una persona',
    pasos: [{ lead: 'Hola, quiero hablar con una persona por favor' }],
    checks: (x) => [
      c(x.briefs('humano').length === 1 && /^\(ATENCIÓN HUMANA - pide humano\)/.test(x.briefs('humano')[0]), 'deriva a humano (pide humano)'),
      c(x.state.paused, 'el agente queda en pausa'),
    ],
  },
  {
    id: 15,
    nombre: 'Alejandro escribe manualmente en la conversación',
    pasos: [
      { lead: 'Hola, buenas' },
      { echo: 'Hola, soy Alejandro de Forja. Te llamo en un ratito.' },
      { lead: 'Dale, gracias' },
    ],
    checks: (x) => [
      c(x.respuestas[0], 'antes de la intervención el agente responde'),
      c(!x.respuestas[2], 'después del mensaje de Alejandro el agente no responde'),
      c(x.state.paused, 'el chat queda en pausa'),
    ],
  },

  // ── Casos sumados con las respuestas del cliente ──────────────────────────
  {
    id: 16,
    nombre: 'Declina un alquiler: no se arma búsqueda',
    pasos: [
      { lead: `Hola, consulto por este depto ${LINK.aurea}` },
      { lead: 'Soy Nadia. Uh, es mucho para mí, no llego' },
      { lead: 'No, gracias, sigo buscando por mi cuenta' },
    ],
    checks: (x) => [
      c(!alguna(x.todas, QUE_BUSCAS), 'no pregunta "¿qué estás buscando?"'),
      c(/otra (unidad|propiedad|opci[oó]n)|otras (unidades|propiedades|opciones)|publicad/i.test(x.respuestas[1]), 'pregunta si le interesa ver otra unidad publicada'),
      c(!alguna(x.todas, /en qu[eé] zona|cu[aá]ntos dormitorios/i) && !alguna(x.todas, PREGUNTA_PRESUPUESTO), 'no releva zona, dormitorios ni presupuesto'),
      c(x.acciones.length === 0, 'no deriva nada (ni búsqueda ni humano)'),
      c(x.state.followup?.status === 'pending', 'cierra cordial y queda el seguimiento'),
    ],
  },
  {
    id: 17,
    nombre: '"Hola, busco algo en Fisherton": primero pregunta comprar o alquilar',
    pasos: [
      { lead: 'Hola, busco algo en Fisherton' },
      { lead: 'Soy Tomás' },
    ],
    checks: (x) => [
      c(alguna(x.todas, /compra\w*[^.?]* o [^.?]*alquil\w*|alquil\w*[^.?]* o [^.?]*compra\w*/i), 'pregunta si busca comprar o alquilar'),
      c(!alguna(x.todas, /cu[aá]ntos dormitorios|qu[eé] tipo de propiedad/i) && !alguna(x.todas, PREGUNTA_PRESUPUESTO), 'no pregunta dormitorios, tipo ni presupuesto antes de saberlo'),
      c(x.acciones.length === 0, 'todavía no deriva'),
    ],
  },
  {
    id: 18,
    nombre: 'Alquiler temporario de 7 días: fechas y personas → brief de temporario',
    pasos: [
      { lead: `Hola, me interesa este depto para alquilar unos días ${LINK.temporario}` },
      { lead: 'Soy Sofía. Sería una semana' },
      { lead: 'Del 10 al 17 de noviembre, somos 4' },
    ],
    checks: (x) => [
      c(alguna(x.respuestas.slice(0, 2), /fecha|ingreso|cu[aá]ndo|desde qu[eé] d[ií]a/i), 'pide las fechas'),
      c(alguna(x.respuestas.slice(0, 2), /cu[aá]ntas personas|cu[aá]ntos (son|ser[ií]an)|hu[eé]spedes/i), 'pide la cantidad de personas'),
      c(x.briefs('temporario').length === 1 && /^\(ALQUILER TEMPORARIO\) .* - Cód\. Tokko .*8638853 - Fechas: .*10.* al .*17.* - Personas: 4 - Sofía - \+\d+$/.test(x.briefs('temporario')[0]), 'brief (ALQUILER TEMPORARIO) con el formato pedido'),
      c(x.briefs('visita').length === 0 && x.briefs('busqueda').length === 0, 'no lo deriva como visita ni como búsqueda'),
      c(!alguna(x.todas, /est[aá] (libre|disponible) (para|en) esas fechas|fechas (est[aá]n|quedan) (libres|disponibles)|te lo reservo|queda reservado/i), 'no confirma disponibilidad de fechas'),
    ],
  },
  {
    id: 19,
    nombre: 'Pregunta por mascotas en una ficha que no dice nada',
    pasos: [
      { lead: `Hola, consulto por este alquiler ${LINK.puertoNorte}` },
      { lead: 'Soy Julia. ¿Aceptan mascotas? Tengo un gato' },
    ],
    checks: (x) => [
      c(/en principio s[ií]/i.test(x.respuestas[1]), 'responde "En principio sí"'),
      c(/confirma (el|un) asesor|asesor (te )?lo confirma/i.test(x.respuestas[1]), '"te lo confirma el asesor"'),
      c(x.briefs('humano').length === 0, 'no hace falta derivar a humano por esto'),
    ],
  },
  {
    id: 20,
    nombre: 'Búsqueda con zona faltante: no deriva hasta tenerla',
    pasos: [
      { lead: 'Hola, quiero comprar un departamento de 2 dormitorios' },
      { lead: 'Soy Nico' },
      { lead: 'No tengo nada excluyente. De presupuesto, unos 120 mil dólares de contado' },
      { lead: 'Dale, pasámelo al asesor' },
      { lead: 'En Fisherton o Funes' },
      { lead: 'Nada más, gracias' },
    ],
    checks: (x) => [
      c(x.briefsAlPaso[3] === 0, 'sin zona no deriva, aunque el lead pida que lo pasen'),
      c(alguna(x.respuestas.slice(0, 4), /zona/i), 'pide la zona'),
      c(x.briefs('busqueda').length === 1 && /Zona: [^-]*(Fisherton|Funes)/.test(x.briefs('busqueda')[0]), 'con la zona, deriva'),
      c(!/Zona: a confirmar/i.test(x.briefs('busqueda')[0] || ''), 'la zona no queda "a confirmar"'),
      c(!/Origen:/.test(x.briefs('busqueda')[0] || '') && x.acciones.some((a) => /^Origen:/.test(a.payload?.nota || '')), 'el brief va limpio y el origen aparte'),
    ],
  },

  // ── Entrega a Alejandro (esquema híbrido) y pausa ─────────────────────────
  {
    id: 21,
    nombre: 'Ventana de Alejandro cerrada: plantilla → toca el botón → brief limpio',
    pasos: [...VISITA_AYACUCHO, { alejandro: 'toca "Recibir para reenviar"' }, { alejandro: 'toca el botón otra vez' }],
    checks: (x) => {
      const brief = x.briefs('visita')[0] || '';
      return [
        c(x.recibidosAlPaso[2] === 1 && x.aAlejandro[0]?.via === 'plantilla', 'con la ventana cerrada sale la plantilla, no texto libre'),
        c(x.aAlejandro[0]?.texto === brief && !brief.includes('\n'), 'la variable de la plantilla es el brief, en una sola línea'),
        c(x.recibidosAlPaso[3] === 2 && x.aAlejandro[1]?.via === 'texto' && x.aAlejandro[1]?.texto === brief, 'al tocar el botón llega el brief limpio, en texto libre'),
        c(x.recibidosAlPaso[4] === 2, 'tocar el botón dos veces no reenvía nada'),
      ];
    },
  },
  {
    id: 22,
    nombre: 'Dos derivaciones con la ventana cerrada: un toque entrega las dos',
    pasos: [
      ...VISITA_AYACUCHO,
      { lead: `También quiero visitar esta casa: ${LINK.kentucky}. Puedo los mismos días` },
      { lead: 'Sí, martes o jueves después de las 17' },
      { alejandro: 'toca "Recibir para reenviar"' },
      { alejandro: 'toca el botón otra vez' },
    ],
    checks: (x) => {
      const briefs = x.briefs('visita');
      const plantillas = x.aAlejandro.filter((m) => m.via === 'plantilla');
      const textos = x.aAlejandro.filter((m) => m.via === 'texto');
      return [
        c(briefs.length === 2, `dos derivaciones de visita (hubo ${briefs.length})`),
        c(plantillas.length === 2 && x.recibidosAlPaso[4] === 2, 'cada una avisó por plantilla'),
        c(textos.length === 2 && briefs.every((b) => textos.some((t) => t.texto === b)), 'un solo toque entrega los dos briefs, cada uno en su mensaje'),
        c(x.recibidosAlPaso[5] === 4 && x.recibidosAlPaso[6] === 4, 'el segundo toque no reenvía nada'),
      ];
    },
  },
  {
    id: 23,
    nombre: 'El lead escribe durante la pausa sin respuesta humana: aviso a Alejandro una sola vez',
    pasos: [
      { lead: 'Hola, quiero hablar con una persona por favor' },
      { lead: 'Hola? ¿Hay alguien?' },
      { lead: 'Sigo esperando' },
      { alejandro: 'toca "Recibir para reenviar"' },
    ],
    checks: (x) => {
      const avisos = x.aAlejandro.filter((m) => /volvió a escribir/.test(m.texto));
      return [
        c(!x.respuestas[1] && !x.respuestas[2], 'en pausa el agente no le responde al lead'),
        c(avisos.filter((m) => m.via === 'plantilla').length === 1, 'le avisa a Alejandro que el lead volvió a escribir, una sola vez'),
        c((avisos[0]?.texto || '').includes('¿Hay alguien?'), 'el aviso lleva lo que escribió el lead'),
        c(x.aAlejandro.filter((m) => m.via === 'texto').length === 2, 'al tocar el botón recibe en limpio la derivación y el aviso'),
      ];
    },
  },
];
