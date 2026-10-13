// Conexión SQLite + migraciones versionadas (db/migrations/NNN_nombre.sql).
// Una sola instancia del servicio. El archivo tiene que vivir en disco
// persistente, fuera de la carpeta del código: la ruta va en DB_PATH.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

const enProduccion = () => process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);

// Producción: DB_PATH es obligatorio y no puede caer dentro del código (se
// borraría en cada deploy, junto con los seguimientos programados).
// Local: sin DB_PATH usa ./data/forja.sqlite.
function defaultPath() {
  const ruta = process.env.DB_PATH;
  if (!enProduccion()) return ruta || path.join(ROOT, 'data', 'forja.sqlite');
  if (!ruta) throw new Error('DB_PATH no está definido. En producción la base tiene que estar en disco persistente (en Railway: dentro del volumen, ej. /data/forja.sqlite).');
  const relativa = path.relative(ROOT, path.resolve(ruta));
  if (!relativa.startsWith('..') && !path.isAbsolute(relativa)) {
    throw new Error(`DB_PATH (${ruta}) apunta dentro de la carpeta del código: se perdería en cada deploy. Usar una ruta dentro del volumen montado.`);
  }
  return ruta;
}

let db = null;

function open(dbPath = defaultPath()) {
  if (db) return db;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(conn) {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const aplicadas = new Set(conn.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const archivos = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const archivo of archivos) {
    const version = archivo.replace(/\.sql$/, '');
    if (aplicadas.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), 'utf8');
    conn.transaction(() => {
      conn.exec(sql);
      conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
    if (conn.name !== ':memory:') console.log(`[db] Migración aplicada: ${version}`);
  }
}

function get() {
  if (!db) throw new Error('DB no abierta: llamar a db.open() primero');
  return db;
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = { open, get, close, defaultPath };
