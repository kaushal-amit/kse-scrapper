'use strict';
/**
 * S-11 · one session end, derived — and the signal window is not the capture
 * window (round 3, item S8).
 *
 * Two defects.
 *
 * 1 · THE AFTER-CLOSE TIMES WERE WRITTEN DOWN, NOT DERIVED. `0 25 13`,
 *     `0 30 13`, `0 40 13` — only the weekday list came from config. Set
 *     END_TIME=14:00 and all three fall INSIDE the window, the after-close
 *     guard rejects them at every tick, and symbol_day and market_day stop
 *     being computed. Silently: a guard doing its job looks exactly like a job
 *     that was never scheduled. (`defaultHistoryCron` was written to fix this
 *     and never called — see S13.)
 *
 * 2 · CAPTURE STOPPED HALF AN HOUR BEFORE THE CLOSE. Boursa Kuwait's continuous
 *     trading runs to 13:30; END_TIME defaulted to 13:00, so the day's high,
 *     low and close were built from a session that was still running.
 *
 * And the distinction the second creates: capture SHOULD run to the close,
 * because the closing prints are data. The fast loop and the wake-up scan
 * should NOT — they raise alerts a human is expected to act on, and there is no
 * acting on one raised at 13:29. Hence SIGNALS_END_TIME, and hence the last
 * half hour being captured and not alerted on.
 */
const path = require('path');
const { execFileSync } = require('child_process');

let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };

const REPO = path.join(__dirname, '..', '..');

/**
 * The scheduler resolves its crons at require time from config, which itself
 * reads the environment once. So each case is a fresh process — the honest way
 * to test "what would this deployment schedule?".
 */
function schedulesFor(env) {
  const script = `
    const { config } = require(${JSON.stringify(path.join(REPO, 'src/config.js'))});
    const s = require(${JSON.stringify(path.join(REPO, 'src/scheduler.js'))});
    process.stdout.write(JSON.stringify({
      end: config.market.endTime,
      signalsEnd: config.market.signalsEndTime,
      after: s.AFTER_CLOSE_JOBS,
      sub: s.SUB_MINUTE_JOBS,
    }));`;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: REPO,
  });
  return JSON.parse(out.slice(out.indexOf('{')));
}

/** 'sec min hour ...' → 'HH:MM' */
const hhmm = (expr) => {
  const [, m, h] = expr.split(' ');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// ── the defaults ────────────────────────────────────────────────────────────
{
  const d = schedulesFor({ END_TIME: undefined, SIGNALS_END_TIME: undefined });
  ck('END_TIME defaults to 13:30 — the real close', d.end === '13:30', d.end);
  ck('SIGNALS_END_TIME defaults to 13:00', d.signalsEnd === '13:00', d.signalsEnd);

  ck('daily.instruments runs at close +1', hhmm(d.after['daily.instruments']) === '13:31', d.after['daily.instruments']);
  ck('daily.symbolday at close +5', hhmm(d.after['daily.symbolday']) === '13:35', d.after['daily.symbolday']);
  ck('daily.marketday at close +12', hhmm(d.after['daily.marketday']) === '13:42', d.after['daily.marketday']);

  ck('instruments runs BEFORE symbolday — the registry must be current first',
    hhmm(d.after['daily.instruments']) < hhmm(d.after['daily.symbolday']));
  ck('and marketday after symbolday, which it reads',
    hhmm(d.after['daily.symbolday']) < hhmm(d.after['daily.marketday']));
}

// ── the chain FOLLOWS the window ────────────────────────────────────────────
{
  // The exact scenario that used to kill the nightly computes.
  const d = schedulesFor({ END_TIME: '14:00', SIGNALS_END_TIME: '13:00' });
  ck('with END_TIME=14:00 instruments moves to 14:01', hhmm(d.after['daily.instruments']) === '14:01', d.after['daily.instruments']);
  ck('symbolday to 14:05', hhmm(d.after['daily.symbolday']) === '14:05', d.after['daily.symbolday']);
  ck('marketday to 14:12', hhmm(d.after['daily.marketday']) === '14:12', d.after['daily.marketday']);
  ck('so NONE of them falls inside the window any more',
    ['daily.instruments', 'daily.symbolday', 'daily.marketday'].every((j) => hhmm(d.after[j]) > '14:00'));

  const narrow = schedulesFor({ END_TIME: '12:00', SIGNALS_END_TIME: '11:30' });
  ck('a narrowed window pulls the chain back too', hhmm(narrow.after['daily.symbolday']) === '12:05', narrow.after['daily.symbolday']);
}

// ── absolute clocks stay absolute ───────────────────────────────────────────
{
  const d = schedulesFor({ END_TIME: '14:00' });
  ck('tradingview.history stays at 17:00 — it waits on the venue, not on us',
    hhmm(d.after['tradingview.history']) === '17:00', d.after['tradingview.history']);
  ck('signals.score stays at 17:45 — it waits on the +15-minute forward prices',
    hhmm(d.after['signals.score']) === '17:45', d.after['signals.score']);
  ck('daily.analysis stays at 08:15 the next morning',
    hhmm(d.after['daily.analysis']) === '08:15', d.after['daily.analysis']);
}

// ── an override still wins ──────────────────────────────────────────────────
{
  const d = schedulesFor({ END_TIME: '13:30', SYMBOLDAY_CRON: '0 7 15 * * 0,1,2,3,4' });
  ck('SYMBOLDAY_CRON overrides the derived time', hhmm(d.after['daily.symbolday']) === '15:07', d.after['daily.symbolday']);
  ck('and the others are still derived', hhmm(d.after['daily.marketday']) === '13:42', d.after['daily.marketday']);
}

// ── the signal jobs stop earlier than capture ───────────────────────────────
{
  const d = schedulesFor({ END_TIME: '13:30', SIGNALS_END_TIME: '13:00' });
  // 'sec min hour-range ...' — the hour range is the third field.
  const fastHours = d.sub['signals.fast'].split(' ')[2];
  const wakeHours = d.sub['signals.wakeup'].split(' ')[2];
  ck('the fast loop is scheduled to hour 12, not 13', fastHours === '9-12', fastHours);
  ck('and so is the wake-up scan', wakeHours === '9-12', wakeHours);
}

// ── a signal window past the capture window is REFUSED ──────────────────────
{
  let threw = false;
  let msg = '';
  try {
    schedulesFor({ END_TIME: '13:00', SIGNALS_END_TIME: '13:30' });
  } catch (e) { threw = true; msg = String(e.stdout || '') + String(e.stderr || ''); }
  ck('SIGNALS_END_TIME after END_TIME refuses the boot', threw, msg.slice(0, 200));
  ck('and says why — it would evaluate minutes nothing was captured for',
    /nothing was captured for|after END_TIME/.test(msg), msg.slice(0, 300));
}

console.log(`\nsession end: ${p}/${n}`);
process.exit(p === n ? 0 : 1);
