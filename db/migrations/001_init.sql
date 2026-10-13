-- Esquema inicial del agente de Forja Propiedades.
-- Compatible con Postgres: solo TEXT / INTEGER / REAL, sin AUTOINCREMENT ni
-- funciones de SQLite. Los ids son UUID generados en la app; las fechas son
-- ISO 8601 UTC (TEXT) y los JSON se guardan como TEXT.

CREATE TABLE leads (
  id               TEXT PRIMARY KEY,
  wa_id            TEXT NOT NULL,
  nombre_perfil    TEXT,
  -- nombre, propiedad_id, busqueda, colega, no_contactar...
  datos            TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'derivado', 'cerrado')),
  source           TEXT NOT NULL DEFAULT 'organico' CHECK (source IN ('ctwa', 'organico')),
  ad_id            TEXT,
  referral         TEXT,
  ctwa_clid        TEXT,
  -- El agente no responde en esta conversación hasta esta fecha.
  paused_until     TEXT,
  paused_at        TEXT,
  pause_reason     TEXT,
  last_inbound_at  TEXT,
  last_outbound_at TEXT,
  derived_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX leads_wa_idx ON leads (wa_id, created_at);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  wa_id         TEXT NOT NULL,
  lead_id       TEXT REFERENCES leads (id),
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  wa_message_id TEXT UNIQUE,
  -- text, image... | echo (lo escribió una persona desde el número de Forja) | followup
  type          TEXT NOT NULL,
  body          TEXT,
  media_id      TEXT,
  -- in:  pendiente -> procesado | pausado
  -- out: enviando -> enviado -> entregado -> leido | fallido | desconocido
  status        TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  processed_at  TEXT
);
CREATE INDEX messages_wa_idx ON messages (wa_id, created_at);
CREATE INDEX messages_pending_idx ON messages (direction, status);

CREATE TABLE lead_events (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads (id),
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, created_at);

-- Briefs enviados a HANDOFF_WHATSAPP. UNIQUE (lead_id, clave) = no se manda
-- dos veces el mismo brief aunque el lead repita el pedido.
CREATE TABLE derivaciones (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads (id),
  -- 'aviso' no es una derivación del lead: es un aviso interno a Alejandro
  -- (el lead volvió a escribir durante la pausa). Viaja por el mismo camino.
  tipo       TEXT NOT NULL CHECK (tipo IN ('visita', 'temporario', 'busqueda', 'humano', 'aviso')),
  clave      TEXT NOT NULL,
  destino    TEXT,
  -- texto: el brief, limpio, listo para reenviar. nota: segundo mensaje aparte (origen, notas internas).
  texto      TEXT NOT NULL,
  nota       TEXT,
  datos      TEXT,
  -- pendiente → enviado            (Alejandro tenía la ventana de 24 hs abierta: texto libre)
  -- pendiente → avisado → enviado  (ventana cerrada: salió la plantilla; el brief limpio se
  --                                 entrega cuando Alejandro toca el botón o escribe)
  -- 'enviando' es el paso intermedio de cada envío; 'fallido' se reintenta.
  status     TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'enviando', 'avisado', 'enviado', 'fallido')),
  avisado_at TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  UNIQUE (lead_id, clave)
);
CREATE INDEX derivaciones_status_idx ON derivaciones (status, created_at);

-- Una fila por lead (UNIQUE lead_id). step = toques ya enviados; anchor_at =
-- última respuesta del agente, desde donde se cuentan los días de FOLLOWUP_DAYS.
-- 'sent' es definitivo: ya recibió todos los toques configurados.
CREATE TABLE followups (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL UNIQUE REFERENCES leads (id),
  due_at     TEXT NOT NULL,
  anchor_at  TEXT,
  step       INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  reason     TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX followups_due_idx ON followups (status, due_at);

-- Catálogo de Tokko sincronizado (src/tokko.js).
CREATE TABLE propiedades (
  id             TEXT PRIMARY KEY,
  reference_code TEXT,
  titulo         TEXT,
  direccion      TEXT,
  slug           TEXT,
  operacion      TEXT,
  precio         REAL,
  moneda         TEXT,
  operaciones    TEXT,
  tipo           TEXT,
  zona           TEXT,
  ubicacion      TEXT,
  sucursal       TEXT,
  dormitorios    INTEGER,
  banos          INTEGER,
  ambientes      INTEGER,
  cocheras       INTEGER,
  sup_total      REAL,
  sup_cubierta   REAL,
  expensas       REAL,
  antiguedad     INTEGER,
  orientacion    TEXT,
  disposicion    TEXT,
  caracteristicas TEXT,
  descripcion    TEXT,
  url            TEXT,
  estado         TEXT NOT NULL DEFAULT 'disponible' CHECK (estado IN ('disponible', 'reservada', 'no_disponible')),
  synced_at      TEXT NOT NULL,
  refreshed_at   TEXT
);
CREATE INDEX propiedades_slug_idx ON propiedades (slug);
CREATE INDEX propiedades_ref_idx ON propiedades (reference_code);

-- Estado suelto del agente (ej. último mensaje entrante de HANDOFF_WHATSAPP,
-- para saber si tiene abierta la ventana de 24 hs).
CREATE TABLE estado (
  clave      TEXT PRIMARY KEY,
  valor      TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_log (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  total      INTEGER,
  error      TEXT,
  created_at TEXT NOT NULL
);
