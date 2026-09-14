'use strict';
/**
 * F-10 · the CR-12 repair script's shift window is bounded at BOTH ends.
 *
 * The defect this pins: the first revision shifted `WHERE trade_date <= cutover`
 * with no lower bound, so every row OLDER than the corruption moved too. On a
 * symbol thin enough to own no Thursday in the shifted range that produces no
 * Fri/Sat row, the commit gate reads zero, and a previously correct history is
 * silently moved one day — on the table feeding symbol_day.prev_close.
 *
 * The three properties tested here are the whole safety argument:
 *   1. --apply REFUSES without --from. There is no safe default lower bound.
 *   2. An inverted or malformed window is refused before anything is written.
 *   3. The backup name is unique per RUN and schema-qualified — a same-day
 *      re-run must not silently reuse the previous snapshot, and the copy must
 *      not land in the backend's `spread` schema via search_path.
 *
 * No database: these are the pure rules, which is exactly why they are the part
 * worth pinning. The DDL path is exercised by hand against staging.
 */
const { validateWindow, backupName } = require('../../scripts/fix-tradingview-dates');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };
const throwsWith = (fn, re) => {
  try { fn(); return { threw: false, msg: '' }; } catch (e) { return { threw: re.test(e.message), msg: e.message }; }
};

// ── 1 · --apply refuses without a lower bound ────────────────────────────────
{
  const r = throwsWith(() => validateWindow({ from: null, cutover: '2026-08-05', apply: true }), /--from/);
  ck('--apply without --from throws', r.threw, r.msg);
  ck('and the message says WHY a default would be unsafe', /older than the corruption|thin symbol|no weekend row/i.test(r.msg), r.msg);

  for (const empty of ['', undefined]) {
    const e = throwsWith(() => validateWindow({ from: empty, cutover: '2026-08-05', apply: true }), /--from/);
    ck(`--from=${JSON.stringify(empty)} counts as absent, not as a value`, e.threw, e.msg);
  }
}

// ── 2 · the dry run may run unbounded — that is how --from is discovered ─────
{
  const w = validateWindow({ from: null, cutover: '2026-08-05', apply: false });
  ck('a dry run without --from is allowed', w.from === null && w.cutover === '2026-08-05', w);
}

// ── 3 · malformed and inverted windows are refused ──────────────────────────
{
  ck('a non-ISO cutover throws',
    throwsWith(() => validateWindow({ from: '2026-07-13', cutover: '05-08-2026', apply: true }), /--cutover must be/).threw);
  ck('a non-ISO from throws',
    throwsWith(() => validateWindow({ from: '13 Jul 2026', cutover: '2026-08-05', apply: true }), /--from must be/).threw);
  ck('from AFTER cutover throws rather than shifting nothing',
    throwsWith(() => validateWindow({ from: '2026-09-01', cutover: '2026-08-05', apply: true }), /empty|after/).threw);

  // A single-day window is legitimate — one corrupted session.
  const one = validateWindow({ from: '2026-08-05', cutover: '2026-08-05', apply: true });
  ck('from === cutover is a valid one-day window', one.from === '2026-08-05' && one.cutover === '2026-08-05', one);

  const ok = validateWindow({ from: '2026-07-13', cutover: '2026-08-05', apply: true });
  ck('a well-formed window passes through unchanged',
    ok.from === '2026-07-13' && ok.cutover === '2026-08-05', ok);
}

// ── 4 · the backup name is per-run and schema-qualified ─────────────────────
{
  const a = backupName(new Date('2026-09-14T08:00:00Z'));
  const b = backupName(new Date('2026-09-14T16:30:45Z'));
  ck('two runs on the SAME DAY produce different backup names', a !== b, [a, b]);
  ck('the name is qualified public.', a.startsWith('public.tradingview_history_backup_'), a);
  ck('the stamp carries the time, not just the date', /_20260914083/.test(a) === false && /_20260914000000$/.test(a) === false, a);
  ck('the stamp is YYYYMMDDHHMMSS', /^public\.tradingview_history_backup_\d{14}$/.test(a), a);
  ck('and it is a legal unquoted identifier', /^public\.[a-z_][a-z0-9_]*$/.test(a), a);
}

console.log(`\ntvhistory fix window: ${p}/${n}`);
process.exit(p === n ? 0 : 1);
