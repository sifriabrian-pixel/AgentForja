# Agente Forja Propiedades

Agente de WhatsApp (Cloud API + Claude) para Forja Propiedades. Replica la forma de trabajar de Alejandro: atiende consultas por unidades con datos de Tokko, deriva pedidos de visita, releva búsquedas y pasa a una persona lo que no le corresponde responder. Todas las derivaciones van a `HANDOFF_WHATSAPP`.

Base: clon adaptado de `kw-paraguay` (mismo core, misma cola por número, mismo adapter de test). Spec: `spec-agente-forja.md` (oct 2026), más los cambios del cliente de la sección siguiente, que tienen prioridad.

## Cómo está armado

| Archivo | Qué hace |
|---|---|
| `config/forja.js` | Todo lo configurable (§9 de la spec): identidad, número de derivación, seguimiento, pausa, frases de Alejandro |
| `prompts/forja.js` | System prompt (estático, cacheado) |
| `index.js` | Servidor HTTP (`/webhook`, `/health`) y las tres tareas periódicas |
| `src/core.js` | Lógica del turno, sin transporte: herramientas, contexto, pausa, seguimiento. Devuelve `{ messages, actions, state }`; nunca envía nada |
| `src/claude.js` | Llamada a Claude y definición de las herramientas |
| `src/briefs.js` | Los tres textos que recibe Alejandro (§5), armados en código |
| `src/tokko.js` | Catálogo: sync a la tabla local, identificación de la unidad y refresco puntual |
| `src/seguimiento.js` | Cuándo y cómo se manda el seguimiento |
| `src/handoff.js` | Entrega de briefs a Alejandro: texto si tiene la ventana de 24 hs abierta, plantilla con botón si no |
| `docs/plantillas-meta.md` | Texto de las dos plantillas para aprobar en Meta |
| `src/agent.js` | Adapter de WhatsApp: cola por número, envío, reintentos, job de seguimiento |
| `src/webhook.js` | Entrada: mensajes, echoes de coexistencia y comandos `#pausa` / `#reanudar` |
| `src/test-adapter.js` | Adapter de test/QA: core real sobre SQLite en memoria, sin enviar nada |
| `src/repo.js` / `src/db.js` | SQLite (WAL) y migraciones en `db/migrations/*.sql` |
| `qa/casos.js` + `qa/run.js` | Los 23 casos de QA (15 del §11 + 8 del cliente) contra el Claude real |

## Cambios del cliente sobre la spec

- **Búsquedas solo de compra** (incluye comprar para inversión o renta). Forja no hace búsquedas de alquiler: `derivar_busqueda` las rechaza.
- **Lead sin unidad puntual**: después del nombre se pregunta si busca comprar o alquilar. Compra → búsqueda. Alquiler → zona y fechas → `derivar_a_humano` con motivo `alquiler`.
- **Declina un alquiler**: no se releva búsqueda; se le ofrece ver otra unidad publicada y, si no, cierre cordial.
- **Alquiler temporario**: fechas de ingreso y salida + cantidad de personas → `derivar_alquiler_temporario`. Nunca se confirma disponibilidad de fechas.
- **Requisitos de alquiler**: solo desde la ficha. No se preguntan garantía ni mascotas. Si la ficha no dice nada de mascotas: "En principio sí, te lo confirma el asesor".
- **Derivación de calidad**: una búsqueda solo sale con tipo, zona y dormitorios completos (el presupuesto puede quedar "a confirmar"). El brief va solo en un mensaje, listo para reenviar; `Origen:` va en un segundo mensaje.
- **Seguimiento**: `FOLLOWUP_DAYS` es una lista (por defecto `5`; para dos toques, `3,7`). Un lead recibe como máximo esa cantidad de toques en toda su vida: el contador no se reinicia cuando contesta.
- **Aviso a Alejandro, esquema híbrido**: si Alejandro le escribió al número en las últimas 24 hs, el brief sale como texto libre. Si no, sale la plantilla `HANDOFF_TEMPLATE_NAME` con el brief y el botón "Recibir para reenviar"; cuando toca el botón (o escribe cualquier cosa) recibe en limpio todos los pendientes. Los briefs se guardan en SQLite y cada uno se entrega una sola vez.
- **Lead que escribe en pausa**: si el agente está en pausa y ninguna persona le respondió al lead desde el número de Forja, se le avisa a Alejandro ("El lead X volvió a escribir: …"), una vez por pausa.
- **Ver otra unidad publicada**: el agente pasa el link de la web ya filtrado (`?operation=Alquiler`, y `&city=` si conoce la ciudad).

## Herramientas del agente

`get_property` · `derivar_visita` · `derivar_alquiler_temporario` · `derivar_busqueda` · `derivar_a_humano` · `programar_seguimiento` · `cancelar_seguimiento` · `search_properties` (solo con `ENABLE_PROPERTY_SEARCH=true`; apagado en v1).

## Garantías (cubiertas por tests)

- **Datos de propiedades**: el agente solo ve lo que hay en Tokko; los campos vacíos le llegan en `sin_dato`.
- **Disponibilidad**: antes de mostrar una ficha o derivar una visita se vuelve a consultar esa unidad en Tokko. Una unidad reservada no se deriva.
- **Presupuesto**: en cuanto el agente lo preguntó una vez, el código le prohíbe volver a preguntarlo.
- **Derivaciones idempotentes**: `UNIQUE (lead, clave)`. Si el lead repite el pedido no sale otro brief. Si el envío falla se reintenta cada 5 minutos (hasta 5 veces). Con la ventana de Alejandro cerrada nunca se manda texto libre: plantilla, o espera a que escriba.
- **Búsqueda**: solo compra, y no se deriva sin tipo, zona y dormitorios. Lo único que puede ir como `a confirmar` es el presupuesto.
- **Pausa**: después de `derivar_a_humano`, de un echo (una persona escribió desde el número) o de `#pausa`, el agente no responde en ese chat. Los mensajes del lead quedan en el historial.
- **Seguimiento**: una sola fila por lead, con tantos toques como tenga `FOLLOWUP_DAYS` (hoy uno) y nunca más; se toma con un `claim` antes de enviar, así que no hay doble envío aunque el job corra dos veces. Se cancela si el lead escribe (y se reprograma con la respuesta siguiente) y no existe para derivados, colegas ni quien pidió no ser contactado. Fuera de la ventana de 24 hs solo sale por plantilla: sin `FOLLOWUP_TEMPLATE_NAME` no se manda nada.
- **Duplicados y redeploy**: igual que KW (`wa_message_id` UNIQUE, pendientes retomados al arrancar).

## Tokko

- `sync()` baja todo el catálogo cada `TOKKO_SYNC_HOURS` (6). Lo que deja de venir queda `no_disponible`, no se borra.
- La unidad se identifica contra la tabla local por: link de la web, id de Tokko, código de referencia, link de portal que traiga el código, o texto (título del anuncio, dirección).
- **Links de la web**: forjapropiedades.com no usa ids sino slugs. La regla es `operación + dirección publicada` (ej. `venta-casa-en-barrio-kentucky-club-de-campo`), y cuando dos fichas chocan agrega `-{id de Tokko}`. Verificada contra las 359 fichas publicadas (oct 2026). El código de la web no está en GitHub (está hecha en v0); la regla se dedujo de su API pública.
- Sin `TOKKO_API_KEY` el catálogo sale de `fixtures/tokko-fichas.json`: 8 fichas reales de la web en el formato de la API (venta, alquiler, Rosario, Buenos Aires, una marcada como reservada y una como alquiler temporario).

## Correr local

```bash
npm install
cp .env.example .env   # completar
npm start
```

## Tests y QA

```bash
npm test      # 70 tests, sin red (Claude falso, WhatsApp capturado)
npm run qa    # los 23 casos de QA contra el Claude real (necesita ANTHROPIC_API_KEY)
```

## Meta directo o Kapso

El agente habla con WhatsApp directo contra Meta o a través de Kapso, sin cambiar código:

| | Meta directo | Kapso |
|---|---|---|
| `WHATSAPP_API_BASE` | vacío | `https://api.kapso.ai/meta/whatsapp/v24.0` |
| `WHATSAPP_TOKEN` | token de la app de Meta | API key del proyecto de Kapso |
| `WHATSAPP_PHONE_NUMBER_ID` | el de Meta | el del número en Kapso |
| Firma del webhook | `WHATSAPP_APP_SECRET` | `KAPSO_WEBHOOK_SECRET` (el `secret_key` del webhook) |
| Webhook | URL + `WHATSAPP_VERIFY_TOKEN` en la app de Meta | webhook tipo **meta** del número apuntando a `/webhook` |

El webhook de Kapso puede ser tipo **meta** (reenvía el formato de Meta) o tipo **kapso** con el evento `whatsapp.message.received` (el único que admite el sandbox de Kapso): el agente acepta los dos y traduce el de Kapso al de Meta. Con Kapso el número se envía tal cual llegó (sin quitar el 9 argentino). El sandbox no envía plantillas, así que ahí el aviso a Alejandro solo sale con la ventana de 24 hs abierta.

## Railway

- Una sola instancia, **sin réplicas** (SQLite + bloqueo por número en proceso). No sirve en serverless.
- Montar un volumen y poner `DB_PATH` dentro (ej. `/data/forja.sqlite`). En producción el agente no arranca sin `DB_PATH` ni con una ruta dentro de la carpeta del código.
- Node 22.x. Variables: ver `.env.example`.

## Pendiente antes de salir a producción

| # | Qué falta | Dónde |
|---|---|---|
| 1 | API key de Tokko de Forja. Al cargarla: verificar los códigos de estado (`config.tokko.estados`) y que el listado de la API traiga las reservadas | `TOKKO_API_KEY` |
| 2 | Número de WhatsApp de Alejandro | `HANDOFF_WHATSAPP` |
| 3 | Aprobar en Meta la plantilla de aviso a Alejandro (texto en `docs/plantillas-meta.md`). Sin ella, con la ventana cerrada el brief queda guardado hasta que Alejandro escriba | `HANDOFF_TEMPLATE_NAME` |
| 4 | Aprobar en Meta la plantilla de seguimiento (mismo documento) | `FOLLOWUP_TEMPLATE_NAME` |
| 5 | Número de Forja y credenciales de Meta. Si es el mismo número que usa Alejandro (coexistencia): suscribir el campo `smb_message_echoes` del webhook y confirmar que los mensajes del propio agente no vuelven como echo | `WHATSAPP_*` |
| 6 | Correr `npm run qa` con la API key de Anthropic y revisar los 23 casos | `ANTHROPIC_API_KEY` |
| 7 | Apagar `#reiniciar` | `config.pruebas` |
| 8 | Las preguntas del §10 que el cliente todavía no respondió (hoy con sus valores por defecto) | `config/forja.js` |
| 9 | Confirmar con la API key los nombres de los tipos de operación de Tokko ("Alquiler temporario" es un tipo propio) | `config.tokko.operaciones` |
| 10 | Texto al lead al derivar un temporario (hoy un default) | `MSG_TEMPORARIO_DERIVADO` |
