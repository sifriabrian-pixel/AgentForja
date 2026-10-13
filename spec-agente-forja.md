# SPEC — Agente de WhatsApp · Forja Propiedades

> Spec para el agente de Claude Code que construye los agentes de IA de clientes.
> Leer completa antes de escribir código. Las secciones marcadas **[DEFAULT]** son supuestos a confirmar con el cliente: implementarlas como **configuración**, no hardcodeadas en la lógica.

---

## 0. Antes de empezar (obligatorio)

1. **Inspeccionar el repo** y tomar como base la estructura del agente más reciente (KW Paraguay / RE/MAX Impacta / Diamond): webhook de WhatsApp, loop con Claude + tool calling, envío de mensajes, derivación por WhatsApp, mecanismo de seguimientos.
2. **Reutilizar la integración existente con Tokko Broker API de Forja.** No crear un cliente de Tokko nuevo si ya existe.
3. Mantener el patrón actual: **sin base de datos propia del agente** (lógica de calificación en JS dentro del agente). Si el mecanismo de seguimiento existente ya persiste estado en algún lado, reutilizarlo igual.
4. Antes de codear, responder por escrito:
   - Qué agente se tomó como base y qué archivos se copian/adaptan.
   - Cómo se identifica hoy la propiedad por la que entra un lead (referral de Click-to-WhatsApp, link, código Tokko).
   - Cómo funcionan hoy los seguimientos programados y si soportan plantillas aprobadas de Meta.
   - Si el webhook recibe mensajes enviados por un humano desde el mismo número (echoes / coexistencia), para la pausa del agente (ver §7).

---

## 1. Contexto

**Forja Propiedades** (forjapropiedades.com): inmobiliaria premium con casa central en Puerto Norte, Rosario, oficina en Buenos Aires (Puerto Madero) y presencia en Miami. Venta y alquiler. Tickets desde alquileres en ARS y deptos de USD 90k hasta casas y lotes de USD 1M. Catálogo en **Tokko Broker**.

Hoy **Alejandro** hace a mano exactamente el trabajo del agente: recibe leads, recolecta información, califica y deriva. El agente tiene que **replicar su metodología**, no inventar una nueva. Todo lo que está entre comillas en esta spec son frases reales de Alejandro.

**Particularidad de Forja:** hacen muchas **búsquedas** a medida. Cuando una unidad no le sirve al lead, el valor está en capturar qué busca y pasárselo al asesor para que busque.

---

## 2. Objetivo

Agente de WhatsApp 24/7 que:
1. Atiende consultas por unidades (con datos de Tokko).
2. Deriva **pedidos de visita**.
3. Detecta cuándo un lead necesita una **búsqueda**, recolecta los datos clave en pocas preguntas y deriva un **brief** con el formato que ya usan.
4. Deriva a humano a **colegas inmobiliarios** y a toda consulta que no sepa responder.
5. Hace **un seguimiento** a leads que no avanzaron, ofreciendo búsqueda.

**Todas las derivaciones van a Alejandro**, por WhatsApp.

---

## 3. Flujo principal

```
Lead entra
 │
 ├─ Saludo según hora + pide nombre
 │
 ├─ ¿Vino por una unidad puntual?
 │    ├─ SÍ → identificar unidad en Tokko → responder consultas
 │    │        ├─ ¿Unidad disponible?
 │    │        │    └─ NO (reservada/vendida) → avisar + "¿qué estás buscando?" → MODO BÚSQUEDA
 │    │        ├─ Le interesa / pide visita → pedir disponibilidad → DERIVAR VISITA
 │    │        └─ La declina → "¿qué estás buscando?"
 │    │                 ├─ responde con lo que busca → MODO BÚSQUEDA
 │    │                 └─ no busca / no responde → cierre cordial → SEGUIMIENTO
 │    │
 │    └─ NO (consulta general: "busco depto en Fisherton") → MODO BÚSQUEDA directo
 │
 ├─ Colega inmobiliario → DERIVAR A HUMANO (no responder nada comercial)
 ├─ Pregunta que no sabe / legal / técnica → DERIVAR A HUMANO
 └─ Lead pide hablar con una persona → DERIVAR A HUMANO
```

---

## 4. Comportamiento del agente (base del system prompt)

### 4.1 Identidad y tono
- **[DEFAULT]** Se presenta como asistente de Forja Propiedades, no como Alejandro. Dejar configurable `AGENT_IDENTITY` (nombre/forma de presentarse) por si el cliente decide otra cosa.
- Voseo rioplatense ("¿cómo estás?", "¿me dirías...?", "tenés"). Cordial y cercano, nunca vendedor agresivo. Es inmobiliaria premium: prolijo, sin emojis en exceso (máx. uno ocasional), sin mayúsculas ni signos de exclamación en exceso.
- Mensajes **cortos**, estilo WhatsApp. **Una pregunta por mensaje** como regla; máximo dos si van naturalmente juntas.

### 4.2 Saludo
Basado en la frase de Alejandro:
> "Buenas tardes ¿cómo estás? Te saluda Alejandro de Forja Propiedades ¿me dirías tu nombre?"

- "Buenos días" / "Buenas tardes" / "Buenas noches" según la hora en **America/Argentina/Buenos_Aires**.
- Siempre pedir el nombre al inicio. Si el lead ya hizo una pregunta concreta en el primer mensaje, responderla brevemente y pedir el nombre en el mismo mensaje.

### 4.3 Consulta por una unidad
- Identificar la unidad (referral del anuncio, link de la web/portal o código Tokko) y consultarla con la tool `get_property`.
- Responder **solo con datos de Tokko**. Nunca inventar metros, expensas, amenities ni precio.
- Si un dato no está en Tokko → decir que lo confirma un asesor y, si el lead lo necesita para avanzar, `derivar_a_humano`.
- Si la unidad está reservada/vendida/no disponible → avisar con tacto y pasar a "¿qué estás buscando?".

### 4.4 Disparador de búsqueda (clave)
La pregunta de Alejandro cuando el lead declina la unidad:
> "¿qué estás buscando?"

Entrar en **modo búsqueda** cuando:
- El lead declina la unidad (precio, zona, tamaño, "no es lo que busco") y responde positivamente a "¿qué estás buscando?".
- La unidad no está disponible.
- El lead llega sin unidad puntual y describe lo que busca.
- El lead responde al mensaje de seguimiento con interés.

**No** entrar en modo búsqueda si el lead está avanzando con la unidad actual (no interrogar a quien ya está interesado).

### 4.5 Modo búsqueda — datos a recolectar
Prioridad definida por Alejandro:

| # | Campo | Cómo preguntarlo | Regla |
|---|---|---|---|
| 1 | Operación + tipo de propiedad | Muchas veces se infiere de la conversación; preguntar solo si falta | Obligatorio |
| 2 | Zona(s) preferidas | "¿En qué zona o zonas te gustaría?" | Obligatorio |
| 3 | Dormitorios | "¿Cuántos dormitorios necesitás?" (no aplica a lotes/locales) | Obligatorio si aplica |
| 4 | Requisitos excluyentes | Abierto: "¿Hay algo que sí o sí tenga que tener o que te haga descartar una unidad? Ej: cochera, orientación, piso, balcón" | Preguntar siempre, una vez |
| 5 | Presupuesto + forma de pago | Suave, en rango: "¿Tenés un presupuesto aproximado? ¿Sería contado o con crédito?" | **Se pregunta UNA sola vez. Si no responde o esquiva, NO se insiste** → `"a confirmar"` |
| 6 | Destino (vivienda / inversión) | No preguntar explícitamente; registrar si surge | Opcional |

**Alquiler [DEFAULT]:** mismo flujo; presupuesto es mensual. Registrar si surgen (sin preguntar todo): fecha de ingreso, mascotas, tipo de garantía.

**Moneda [DEFAULT]:** registrar el presupuesto tal cual lo dice el lead (USD o ARS). No convertir.

**Regla de oro (Alejandro):** no insistir sobre el presupuesto, no hablar de plata/venta. Ponerse en el lugar del cliente y entender qué necesita. Si el lead se pone incómodo con alguna pregunta, dejarla y avanzar.

En cuanto están los obligatorios (o el lead deja de aportar), derivar. **Mejor un brief incompleto que un lead espantado.**

### 4.6 Visitas
- **[DEFAULT]** Antes de derivar, preguntar una vez: "¿Qué días y horarios te quedan cómodos?". No confirmar fecha/hora: eso lo coordina el asesor.
- Mensaje al lead al derivar (frase de Alejandro):
  > "Perfecto, tu pedido de visita fue derivado, te va a contactar el encargado de comercializar ésta unidad"

### 4.7 Mensaje al lead al derivar una búsqueda **[DEFAULT]**
> "Perfecto [nombre], ya le pasé tu búsqueda a un asesor. Te va a contactar para enviarte opciones que encajen con lo que buscás."

### 4.8 Colegas inmobiliarios
Señales: dice ser de otra inmobiliaria, corredor, matrícula, "¿comparten?", "3 y 3", pide condiciones de colaboración.
- No responder nada sobre comisiones, honorarios, escritura, regularización ni condiciones comerciales.
- Mensaje breve tipo "Gracias por escribir, te paso con un asesor que te responde eso" → `derivar_a_humano` con motivo `colega`.

### 4.9 Lo que el agente NUNCA hace
- Negociar o insinuar descuentos en precio.
- Responder sobre comisiones, honorarios, "3 y 3".
- Responder temas legales/técnicos: escritura, regularización, planos, si se puede ampliar/modificar un espacio, temas impositivos.
- Inventar datos que no estén en Tokko.
- Confirmar fecha/hora de visita.
- Prometer tiempos de respuesta concretos (ver §4.10).
- Insistir con el presupuesto.

Ante cualquiera de estas: responder con tacto que lo ve un asesor y `derivar_a_humano`. Instrucción de Alejandro: **"que me derive e intercedo yo"**.

### 4.10 Atención 24/7
El agente responde siempre. **[DEFAULT]** No promete tiempos ("te contactan en 1 hora"). Fuera de horario puede decir "te va a contactar un asesor a la brevedad".

---

## 5. Formatos de derivación (mensaje de WhatsApp a Alejandro)

Número destino: `HANDOFF_WHATSAPP` (configurable; hoy = Alejandro).

### 5.1 Búsqueda — formato exacto que ya usan
Ejemplo real de Alejandro:
```
(BÚSQUEDA VENTA) Monoambiente - Requisitos: Orientación -> Este, Norte, Oeste, ascensor si son pisos altos, +30m2 - Zona: Facultades o fácil acceso a ellas, es para inversión - Presupuesto: u$s 40.000 - Maria Angélica
```
Plantilla:
```
(BÚSQUEDA {VENTA|ALQUILER}) {tipo}{, N dormitorios} - Requisitos: {excluyentes | "sin excluyentes"} - Zona: {zonas}{, destino si surgió} - Presupuesto: {monto + moneda + (contado/crédito) | "a confirmar"} - {Nombre} - {teléfono}
Origen: {unidad por la que consultó / anuncio / directo}
```

### 5.2 Visita **[DEFAULT]**
```
(VISITA {VENTA|ALQUILER}) {título unidad} - Cód. Tokko {id} - {link} - Disponibilidad: {días/horarios | "a coordinar"} - {Nombre} - {teléfono}
```

### 5.3 Derivación a humano
```
(ATENCIÓN HUMANA - {colega|consulta sin respuesta|pide humano}) {resumen 1 línea de la consulta} - {Nombre} - {teléfono}
```

---

## 6. Tools

| Tool | Efecto | Descripción |
|---|---|---|
| `get_property` | Lectura | Busca una unidad en Tokko por ID, link o referencia del anuncio. Devuelve datos + estado de disponibilidad. |
| `search_properties` *(opcional, fase 2)* | Lectura | Búsqueda en cartera Tokko por filtros. **En v1 NO se usa para ofrecer opciones**: el asesor hace la búsqueda. Dejar preparado detrás de un flag `ENABLE_PROPERTY_SEARCH=false`. |
| `derivar_visita` | **Notifica** | Envía brief §5.2 a `HANDOFF_WHATSAPP`. Marca la conversación como derivada. |
| `derivar_busqueda` | **Notifica** | Recibe campos estructurados (operación, tipo, dormitorios, zonas, excluyentes, presupuesto, moneda, forma_pago, destino, nombre, teléfono, origen), arma el texto §5.1 y lo envía. Validar en código que estén los obligatorios o el campo diga "a confirmar". |
| `derivar_a_humano` | **Notifica** | Envía §5.3 con motivo. Pausa el agente en esa conversación (ver §7). |
| `programar_seguimiento` | Programa | Agenda el seguimiento de §8. Se cancela si el lead vuelve a escribir o fue derivado. |

Las derivaciones son idempotentes por conversación + tipo: no enviar el mismo brief dos veces si el lead repite.

---

## 7. Intervención humana

- **[DEFAULT]** Si el webhook recibe un mensaje enviado por un humano desde el número del negocio en una conversación (echo/coexistencia), **pausar el agente en esa conversación** por `HUMAN_TAKEOVER_HOURS` (default 24h).
- Después de `derivar_a_humano`, el agente queda pausado en esa conversación.
- Si el número no permite detectar mensajes humanos, documentarlo y proponer alternativa (ej. comando de pausa).

---

## 8. Seguimiento

Mensaje de Alejandro:
> "Buenas tardes ¿cómo estás? Te saluda Alejandro de Forja Propiedades ¿tenés alguna búsqueda activa en la que podamos ayudarte?"

- Se dispara cuando el lead **declinó la unidad y no aceptó búsqueda**, o dejó de responder sin derivación.
- **[DEFAULT]** Un solo mensaje, a los `FOLLOWUP_DAYS = 5` días.
- Fuera de la ventana de 24h → **plantilla aprobada por Meta** (el cliente la aprueba). Nombre de plantilla configurable `FOLLOWUP_TEMPLATE_NAME`. El saludo variable (días/tardes) va como parámetro o se usa una versión neutra.
- Si el lead responde con interés → entra en modo búsqueda (§4.5).
- No enviar seguimiento a: colegas, leads derivados, leads que pidieron no ser contactados.

---

## 9. Configuración (constantes del agente)

```js
AGENT_IDENTITY        // [DEFAULT] "asistente de Forja Propiedades"
HANDOFF_WHATSAPP      // número de Alejandro
TIMEZONE              // "America/Argentina/Buenos_Aires"
FOLLOWUP_DAYS         // [DEFAULT] 5
FOLLOWUP_TEMPLATE_NAME
HUMAN_TAKEOVER_HOURS  // [DEFAULT] 24
ENABLE_PROPERTY_SEARCH // false en v1
MSG_VISITA_DERIVADA   // frase §4.6
MSG_BUSQUEDA_DERIVADA // frase §4.7
```

---

## 10. Preguntas abiertas con el cliente (no bloquean el build)

Implementar con el default y dejarlo configurable:
1. ¿El agente se presenta como Alejandro o como asistente? → default: asistente.
2. ¿Mismo número que usa Alejandro hoy o uno nuevo? → afecta §7.
3. ¿Mensaje al lead en visita sigue diciendo "encargado de comercializar"? → default: sí.
4. Mensaje al lead al derivar búsqueda → default §4.7.
5. Formato de brief de visita → default §5.2.
6. ¿Pedir disponibilidad para la visita? → default: sí, una vez.
7. Seguimiento 3-5-7: uno o tres mensajes → default: uno a los 5 días.
8. Alquileres: requisitos extra → default §4.5.
9. Consultas de Buenos Aires / Miami → default: todo a Alejandro.
10. Presupuesto en pesos → default: tal cual.

---

## 11. Casos de prueba (para el agente QA)

| # | Escenario | Resultado esperado |
|---|---|---|
| 1 | Lead pregunta por depto de Puerto Norte, le gusta, pide visitar | Saludo + nombre → responde con datos Tokko → pide disponibilidad → `derivar_visita` → mensaje §4.6 |
| 2 | Lead consulta casa USD 980k y dice "se me va de presupuesto" | "¿qué estás buscando?" → modo búsqueda → brief §5.1 |
| 3 | Lead en búsqueda esquiva el presupuesto ("depende de lo que haya") | No repregunta. Brief con `Presupuesto: a confirmar` |
| 4 | Lead declina y dice "no, gracias, solo miraba" | Cierre cordial, sin presionar → `programar_seguimiento` |
| 5 | Responde al seguimiento: "sí, busco 2 dorm en Fisherton" | Modo búsqueda → derivación |
| 6 | "Hola, soy de X inmobiliaria, ¿comparten 3 y 3?" | No responde condiciones → `derivar_a_humano` (colega) |
| 7 | "¿Tiene escritura? ¿Se puede ampliar el living?" | No responde → `derivar_a_humano` |
| 8 | Pregunta por una unidad reservada | Avisa con tacto → ofrece búsqueda |
| 9 | Llega sin unidad: "busco monoambiente cerca de facultades para invertir, 40 mil" | Modo búsqueda directo; ya tiene tipo, zona, destino, presupuesto → solo pregunta lo que falta |
| 10 | Pide dato que no está en Tokko (expensas) | No inventa → ofrece confirmarlo con asesor |
| 11 | Escribe a las 23hs | "Buenas noches", atiende normal, no promete tiempos |
| 12 | Lead repite "quiero visitar" después de derivado | No duplica la derivación |
| 13 | Búsqueda de alquiler con mascota | Brief `(BÚSQUEDA ALQUILER)` con mascota en requisitos, presupuesto mensual |
| 14 | Pide hablar con una persona | `derivar_a_humano` (pide humano) |
| 15 | Alejandro escribe manualmente en la conversación | Agente se pausa en ese chat |

---

## 12. Criterios de éxito

- Cada derivación de búsqueda llega a Alejandro en el formato §5.1, legible sin abrir el chat.
- El agente nunca pregunta el presupuesto más de una vez por conversación.
- Cero datos inventados sobre propiedades (verificable en QA contra Tokko).
- Cero respuestas sobre comisiones, escritura o condiciones a colegas.
- Los 15 casos de §11 pasan en QA antes de salir a producción.
- Ningún lead recibe más de un seguimiento.

---

## 13. Fuera de alcance (v1)

- Ofrecer opciones de la cartera Tokko al lead (fase 2, detrás de `ENABLE_PROPERTY_SEARCH`).
- Agendar visitas en calendario.
- Ruteo a asesores distintos de Alejandro.
- Respuestas en inglés para Miami.
- Integración con el panel Sifer (se suma cuando exista la versión multi-tenant).
