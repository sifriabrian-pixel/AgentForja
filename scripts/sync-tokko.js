// Sincroniza el catálogo a mano y muestra un resumen.
//   node scripts/sync-tokko.js            baja el catálogo (API si hay TOKKO_API_KEY; si no, fixtures)
//   node scripts/sync-tokko.js <texto>    además prueba a identificar una unidad (link, código, dirección)
require('dotenv').config({ quiet: true });
const db = require('../src/db');
const tokko = require('../src/tokko');

(async () => {
  db.open();
  const { source, total } = await tokko.sync();
  console.log(`Catálogo sincronizado: ${total} unidades (origen: ${source})`);
  const porEstado = db.get().prepare('SELECT estado, COUNT(*) AS n FROM propiedades GROUP BY estado').all();
  console.log(porEstado.map((r) => `${r.estado}: ${r.n}`).join(' · '));

  const referencia = process.argv.slice(2).join(' ');
  if (referencia) {
    const res = tokko.buscar(referencia);
    if (res.propiedad) console.log(`Encontrada por ${res.por}:`, tokko.resumen(res.propiedad));
    else if (res.candidatas) console.log('Varias candidatas:', res.candidatas.map(tokko.resumen));
    else console.log('No se encontró ninguna unidad con esa referencia.');
  }
  db.close();
})().catch((e) => {
  console.error('[sync-tokko]', e.message);
  process.exit(1);
});
