// CR-12 · the tradingview_history date writer.
//
// The seven-month corruption was `new Date(ts*1000).toISOString()` reading a
// Kuwait-midnight bar in UTC — one day early, and Saturday sessions that cannot
// exist. These are pure (no DB): the day resolution and the weekend refuse-guard.
const hist = require('../../src/scrapers/historyTransform');
let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, JSON.stringify(x)); };

// A daily bar stamped at Kuwait-midnight (UTC+3) — 2026-07-14 00:00 Kuwait is
// 2026-07-13 21:00 UTC. The old UTC read gave 2026-07-13; Kuwait read gives 14.
const kuwaitMidnight = Date.UTC(2026, 6, 13, 21, 0, 0) / 1000;      // → 2026-07-14 (Tue)
const utcMidnight = Date.UTC(2026, 6, 14, 0, 0, 0) / 1000;         // already 2026-07-14

ck('tsToKuwaitDay resolves an exchange-local-midnight bar to the session day',
  hist.tsToKuwaitDay(kuwaitMidnight) === '2026-07-14', hist.tsToKuwaitDay(kuwaitMidnight));
ck('tsToKuwaitDay leaves a UTC-midnight bar on the same day',
  hist.tsToKuwaitDay(utcMidnight) === '2026-07-14', hist.tsToKuwaitDay(utcMidnight));

// rowDay prefers the DISPLAYED date (timezone-free) over the epoch.
ck('rowDay prefers the displayed date over the epoch',
  hist.rowDay({ dateText: "5 Aug '26", ts: kuwaitMidnight }) === '2026-08-05',
  hist.rowDay({ dateText: "5 Aug '26", ts: kuwaitMidnight }));
ck('rowDay falls back to the Kuwait epoch when no text',
  hist.rowDay({ dateText: null, ts: kuwaitMidnight }) === '2026-07-14',
  hist.rowDay({ dateText: null, ts: kuwaitMidnight }));

// The weekend guard: Boursa runs Sun–Thu.
ck('Saturday is a weekend', hist.isWeekendDay('2026-08-01') === true);   // Sat
ck('Friday is a weekend', hist.isWeekendDay('2026-08-07') === true);     // Fri
ck('Tuesday is not', hist.isWeekendDay('2026-07-14') === false);        // Tue
ck('Sunday is not', hist.isWeekendDay('2026-08-02') === false);         // Sun

// buildDailyRows end to end: a weekday kept, a Saturday and a Friday refused.
const headers = ['Date', 'Open', 'High', 'Low', 'Close', 'Change', 'Volume'];
const vals = ['100', '102', '99', '101', '+1', '1000'];
const rows = [
  { dateText: null, ts: kuwaitMidnight, values: vals },  // 2026-07-14 Tue — kept
  { dateText: "1 Aug '26", ts: null, values: vals },     // Sat — refused
  { dateText: "7 Aug '26", ts: null, values: vals },     // Fri — refused
];
const out = hist.buildDailyRows(rows, headers, { symbol: 'CATTL' });
ck('the weekday row is kept with the correct session date',
  out.rows.length === 1 && out.rows[0].trade_date === '2026-07-14', out.rows);
ck('both weekend rows are refused, not written',
  out.weekendSkipped === 2 && !out.rows.some((r) => hist.isWeekendDay(r.trade_date)), out);
ck('the refusal names the reason', /weekend date refused/.test((out.reasons || []).join(' | ')), out.reasons);

console.log(`\ntvhistory-date: ${p}/${n}`);
process.exit(p === n ? 0 : 1);
