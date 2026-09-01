// A build that cannot identify itself is a build nobody can debug.
//
// Two scripts both reported @version 2.0.0 — one with the money fields and the
// iframe walk, one without. Tampermonkey showed the same string for each, so a
// session went into diagnosing a bug that had already been fixed.
const fs = require('fs');
const path = require('path');
let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };

const dir = path.join(__dirname, '../../userscript');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.user.js'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  const header = (s.match(/@version\s+([\d.]+)/) || [])[1];
  const constant = (s.match(/var VERSION = '([\d.]+)'/) || [])[1];

  ck(`${f} declares @version`, !!header, header);
  ck(`${f} carries it as a constant`, !!constant, constant);
  ck(`${f} — the two AGREE, so the panel cannot lie`, header === constant, [header, constant]);
  ck(`${f} shows it on the panel`, /h\.textContent = .*VERSION/.test(s));
}

// The orders script specifically: the two fixes that were invisible.
const orders = fs.readFileSync(path.join(dir, 'awsat-orders.user.js'), 'utf8');
ck('orders maps the MONEY fields — order_value and net_value were NULL without them',
   /netOrdVal:\s*'netValue'/.test(orders) && /ordVal:\s*'orderValue'/.test(orders));
// rec keys are CELL_MAP's VALUES, not its keys. Reading rec.ordVal sent
// undefined — captured, then lost one line before the POST.
ck('orders SENDS them, reading the MAPPED key',
   /ordVal: num\(rec\.orderValue\)/.test(orders)
   && /netOrdVal: num\(rec\.netValue\)/.test(orders));
ck('orders walks iframes — the widget renders in one on the terminal page',
   /function collectDocs/.test(orders));
ck('and does NOT gate on the active tab — that markup differs between the '
   + 'embedded widget and the popped-out window',
   !/\^order list\$\/i\.test/.test(orders));

// Two scripts still pointed at http://localhost:8787 — the orders one and the
// CAPTURE one, which holds the symbol master everything else depends on. They
// post into nothing from the broker's page and report success doing it.
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.user.js'))) {
  const s2 = fs.readFileSync(path.join(dir, f), 'utf8');
  ck(`${f} posts to the deployed server, not localhost`,
     !/localhost:8787/.test(s2), (s2.match(/var SERVER[^;]*/) || [])[0]);
}

console.log(`\nuserscript versions: ${p}/${n}`);
process.exit(p === n ? 0 : 1);
