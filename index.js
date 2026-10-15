require('dotenv').config({ quiet: true });
const http = require('http');

const config = require('./config/forja');
const db = require('./src/db');
const whatsapp = require('./src/whatsapp');
const webhook = require('./src/webhook');
const agent = require('./src/agent');
const tokko = require('./src/tokko');

const MINUTO = 60 * 1000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function checkEnv() {
  const faltan = ['ANTHROPIC_API_KEY', 'WHATSAPP_VERIFY_TOKEN'].filter((k) => !process.env[k]);
  if (process.env.WHATSAPP_DRY_RUN !== '1') faltan.push(...['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'].filter((k) => !process.env[k]));
  if (faltan.length) console.warn(`[config] Faltan variables de entorno: ${faltan.join(', ')}`);
  if (!process.env.WHATSAPP_APP_SECRET && !process.env.KAPSO_WEBHOOK_SECRET) {
    if (process.env.WHATSAPP_DRY_RUN === '1') console.warn('[config] Sin WHATSAPP_APP_SECRET ni KAPSO_WEBHOOK_SECRET: el webhook no verifica firmas (modo prueba)');
    else console.error('[config] Sin WHATSAPP_APP_SECRET ni KAPSO_WEBHOOK_SECRET: el webhook rechaza todos los mensajes hasta que se configure uno');
  }
  if (!config.HANDOFF_WHATSAPP) console.error('[config] HANDOFF_WHATSAPP no configurado: las derivaciones quedan guardadas pero no se le avisa a nadie');
  if (!process.env.TOKKO_API_KEY) console.warn('[config] TOKKO_API_KEY no configurado: el catálogo sale de las fichas de ejemplo (fixtures), NO del Tokko real');
  if (!config.FOLLOWUP_TEMPLATE_NAME) console.warn('[config] FOLLOWUP_TEMPLATE_NAME no configurado: los seguimientos fuera de la ventana de 24 hs no se envían');
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/webhook' && req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe'
        && url.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
      res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' });
      res.end(ok ? url.searchParams.get('hub.challenge') : 'Forbidden');
      return;
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!whatsapp.verifySignature(raw, req.headers)) {
        console.error('[webhook] Firma inválida — rechazado');
        res.writeHead(403);
        res.end();
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        // Se persiste ANTES de responder 200: si falla, Meta reintenta y
        // el wa_message_id UNIQUE evita duplicados.
        webhook.handlePayload(payload);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      } catch (e) {
        console.error('[webhook] Error guardando el payload:', e);
        res.writeHead(500);
        res.end();
      }
      return;
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] Escuchando en puerto ${PORT}`));
  return server;
}

// Tarea periódica que no se pisa con su corrida anterior ni tira abajo el proceso.
function cada(ms, nombre, tarea) {
  const correr = () => tarea().catch((e) => console.error(`[${nombre}] Error:`, e.message));
  correr();
  setInterval(correr, ms).unref();
}

if (require.main === module) {
  console.log(`[server] Node ${process.version} · better-sqlite3 ${require('better-sqlite3/package.json').version}`);
  console.log(`[server] WhatsApp vía ${process.env.WHATSAPP_API_BASE ? new URL(process.env.WHATSAPP_API_BASE).host : 'graph.facebook.com'}`);
  checkEnv();
  const ruta = db.defaultPath();
  db.open(ruta);
  console.log(`[db] Base en ${ruta}`);
  agent.recover();

  cada(config.tokko.syncHoras * 60 * MINUTO, 'tokko', async () => {
    const { source, total } = await tokko.sync();
    console.log(`[tokko] Catálogo sincronizado: ${total} unidades (${source})`);
  });
  cada(5 * MINUTO, 'derivacion', () => agent.retryNotices());
  cada(15 * MINUTO, 'seguimiento', () => agent.runFollowups());

  const server = startServer();

  // Railway manda SIGTERM en cada redeploy: dejar de aceptar y cerrar la base.
  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM — cerrando');
    server.close();
    agent.idle().finally(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

module.exports = { startServer };
