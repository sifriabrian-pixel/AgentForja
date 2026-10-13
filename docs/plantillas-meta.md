# Plantillas para aprobar en Meta — Agente Forja

Son dos. Se cargan en el WhatsApp Manager de la cuenta de Forja (Plantillas de mensajes → Crear plantilla). Cuando estén aprobadas, el nombre de cada una va en el `.env`.

---

## 1. Aviso a Alejandro — `forja_aviso_lead`

Se usa cuando hay un brief para Alejandro y él no le escribió al número en las últimas 24 hs. Al tocar el botón recibe el brief en un mensaje limpio, listo para reenviar al grupo.

| Campo | Valor |
|---|---|
| Nombre | `forja_aviso_lead` |
| Categoría | Utilidad (Utility) |
| Idioma | Español (Argentina) — `es_AR` |
| Encabezado | ninguno |
| Pie | ninguno |

**Cuerpo:**

```
Tenés un nuevo aviso del asistente de Forja Propiedades:

{{1}}

Tocá el botón para recibirlo en un mensaje aparte, listo para reenviar.
```

**Botón** (tipo "Respuesta rápida"), uno solo:

```
Recibir para reenviar
```

**Ejemplo para la variable `{{1}}`** (Meta lo pide al enviar a revisión):

```
(BÚSQUEDA VENTA) Monoambiente - Requisitos: Orientación Este, Norte u Oeste, ascensor si es piso alto, +30m2 - Zona: Facultades o fácil acceso a ellas, es para inversión - Presupuesto: u$s 40.000 - Maria Angélica - +5493415551234
```

Variable de entorno: `HANDOFF_TEMPLATE_NAME=forja_aviso_lead`

Notas:
- La variable va en una sola línea (el agente lo garantiza) y se recorta a 900 caracteres; el brief completo llega igual al tocar el botón.
- La misma plantilla se usa para el aviso "El lead X volvió a escribir: …".
- No hace falta configurar nada en el botón: cualquier mensaje de Alejandro al número (el toque o un "ok") dispara la entrega.

---

## 2. Seguimiento al lead — `forja_seguimiento`

Es el único mensaje que el agente le manda a un lead que no avanzó, a los 5 días.

| Campo | Valor |
|---|---|
| Nombre | `forja_seguimiento` |
| Categoría | Marketing (ver nota) |
| Idioma | Español (Argentina) — `es_AR` |
| Encabezado | ninguno |
| Pie | ninguno |
| Botones | ninguno |

**Cuerpo** (sin variables):

```
Hola ¿cómo estás? Te saluda el asistente de Forja Propiedades ¿tenés alguna búsqueda activa en la que podamos ayudarte?
```

Variable de entorno: `FOLLOWUP_TEMPLATE_NAME=forja_seguimiento`

Notas:
- **Categoría:** un mensaje que retoma el contacto con alguien que dejó de responder es, para Meta, marketing. Si se carga como utilidad lo más probable es que lo rechacen o lo recategoricen solos. Las plantillas de marketing tienen costo por conversación y el lead puede bloquearlas.
- **Sin saludo por hora:** el mensaje original de Alejandro empieza con "Buenas tardes", pero Meta no admite una variable al inicio del cuerpo. Por eso va "Hola". Dentro de la ventana de 24 hs (seguimientos cortos) el agente sí usa "Buenos días / Buenas tardes / Buenas noches".
- **Tiene que coincidir con el código:** este texto es el mismo que `MSG_SEGUIMIENTO_PLANTILLA` en `config/forja.js` (es lo que queda en el historial de la conversación). Si Forja decide que el agente se presente de otra forma, hay que cambiar los dos.
