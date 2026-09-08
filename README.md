# KSE Scraper

Scrapes Boursa Kuwait market data from TradingView and the AWSAT broker terminal
into PostgreSQL, on a schedule, Sunday to Thursday.

---

## Read this first — three things in the specification need a decision

These are stated rather than assumed. Each is a one-line configuration change,
and the code ships with exactly what was asked for.

### 1. The window stops before the market closes

The specification says **09:00–13:00**. Boursa Kuwait's continuous session runs
to **13:30**, with the closing auction after that.

As configured, the scraper stops ~30 minutes early and **never captures the
closing print** — the price most end-of-day analysis is built on. The last
half-hour is also usually the most active part of the session.

If that is intended, nothing needs doing. If not:

```bash
END_TIME=13:40      # covers continuous trading and the closing auction
```

### 2. Post-market prices cannot be collected inside the window

The earlier requirements included a post-market price scrape. By definition
those figures only exist *after* the close, which is outside a 09:00–13:00
window — the two requirements cannot both hold.

Not implemented, because implementing it would mean silently running outside the
schedule you specified. It needs either a widened window or an explicit
exception.

### 3. Depth cannot cover every symbol every minute

One terminal session displays one order book at a time. Stepping through ~135
symbols takes several minutes, so a full-market depth sweep every minute is not
achievable through this interface.

`DEPTH_SYMBOLS` is therefore an explicit shortlist, and **empty by default** —
capturing a few books properly is worth more than sampling all of them badly.

```bash
DEPTH_SYMBOLS=ABAR,ZAIN,NBK,KFH
```

### Also worth knowing

- **The AWSAT selectors are starting points, not verified.** They are collected
  at the top of `src/scrapers/awsat.js`. Every extractor returns an empty array
  rather than throwing, so a wrong selector appears as `rows_extracted = 0` in
  `scrape_runs` instead of a crash loop. See *Adapting the AWSAT selectors*.
- **The terminal limits login attempts per day.** The scraper logs in **once**
  per process and **never retries a failed login** — a retry loop would burn the
  remaining attempts and lock the account out for the whole session. If login
  fails, fix the credentials and restart.
- **The Tampermonkey bridge is not included.** It would require an HTTP server,
  request signing and replay protection — a large surface for something that may
  be unnecessary if Playwright can read the terminal directly. Worth confirming
  against the live terminal before building it.

---

## Requirements

- Node.js 18+
- PostgreSQL 12+
- Chromium via Playwright (`npx playwright install chromium`)

## Setup

```bash
npm install
npx playwright install chromium        # downloads the browser

cp .env.example .env                   # then edit DATABASE_URL and credentials

npm run setup                          # create the database and apply migrations
npm test                               # 44 checks; confirms the setup works
npm start                              # start the scheduler
```

`npm run setup` is `db:create` followed by `migrate`. The database is created by
a script rather than by a migration because `CREATE DATABASE` cannot run inside
a transaction, and connecting to a database in order to create that same
database is circular.

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Run the scheduler. Scrapes only inside the window. |
| `npm run setup` | Create the database and apply migrations. |
| `npm run db:create` | Create the database if absent. Safe to re-run. |
| `npm run migrate` | Apply pending migrations. |
| `npm test` | 44 checks: schedule, parsing, validation, persistence, schema. |
| `npm run tv:probe` | Diagnose what the TradingView page is actually doing. |
| `npm run tv:login` | Capture a TradingView session, once, by hand. |
| `npm run migrate:status` | Show what would be applied; changes nothing. |
| `npm run run:once <job>` | Run one scraper immediately, ignoring the window. |
| `npm run check` | Syntax check. |

Jobs: `tradingview.quotes`, `awsat.board`, `awsat.depth`, `awsat.orders`.

```bash
npm run run:once tradingview.quotes    # verify selectors without waiting for Sunday
```

---

## Schedule

Sunday–Thursday, 09:00–13:00 **Asia/Kuwait**. Friday and Saturday are the Kuwaiti
weekend and are excluded.

Jobs are staggered across the minute because they share one browser and are
serialised — starting together would only queue them:

| Job | Second |
|---|---|
| `tradingview.quotes` | :05 |
| `awsat.board` | :15 |
| `awsat.depth` | :30 |
| `awsat.orders` | :45 |

The window is enforced **twice**: `node-cron` is given the Kuwait timezone and a
weekday restriction so ticks do not arrive outside it, and `clock.isWithinWindow()`
is checked again inside every handler. If the two ever disagree, the explicit
check decides. The rule lives in `src/market/clock.js`; cron is only an
optimisation that avoids waking up pointlessly.

Timezone handling uses the built-in `Intl` API against the system tz database —
no timezone dependency to go stale. Comparing `new Date().getHours()` against 9
would be correct only if the server itself were in Kuwait, and silently wrong by
hours otherwise.

### Halts reach `signal_log` at 17:45, not intraday (G-8)

Halt-resume firings are detected live by the **backend** (`spread:halt` is the
alert path, in real time). They land in `public.signal_log` only when
`signals.score` runs at **17:45**: its first step mirrors that day's
`spread.halt_event` RESUME rows into `signal_log` as `signal = 'HALT_RESUME'`,
then scores them. So **anything reading `signal_log` intraday does not see
today's halts** — they appear after 17:45, and `daily.analysis` (next morning)
sees them. Nothing in the trading path depends on the mirror being real-time; the
operator's alert is `spread:halt`, which fires the moment the symbol resumes.

---

## Project structure

```
src/
  index.js              startup, shutdown, signal handling
  scheduler.js          cron wiring and the window guard
  jobs.js               run tracking: start -> scrape -> persist -> record
  config.js             environment, validated once at boot
  logger.js             levelled line logging
  market/clock.js       the Asia/Kuwait window — one definition, one place
  browser/browser.js    Playwright lifecycle, serialised access
  scrapers/
    parse.js            scraped text -> values
    tradingview.js      the Kuwait board
    awsat.js            broker board, depth, order list
  db/
    pool.js             connection pool
    migrate.js          migration runner
    repositories.js     every write, in one module
    migrations/
      001_init.sql
```

---

## Database

Five tables in the `public` schema.

| Table | Holds | Unique on |
|---|---|---|
| `symbols` | the instrument list | `symbol` |
| `scrape_runs` | one row per execution | `id` |
| `quotes` | per-symbol, per-minute prices | `(symbol, minute_bucket, source)` |
| `depth_levels` | order-book ladder | `(symbol, captured_at, level)` |
| `orders` | broker order list snapshots | `(order_id, captured_at)` |

**Deduplication is the database's job.** Every insert is
`ON CONFLICT DO NOTHING` against a real unique constraint, so a retry, an
overlapping run, or a second process started by mistake cannot create duplicate
rows — none of which the application can reliably detect on its own.

A few decisions worth knowing about:

- **`minute_bucket` is supplied by the application**, never defaulted to `now()`.
  A default would make every retry a distinct row and the unique constraint would
  deduplicate nothing.
- **Prices are `numeric`, never float.** Kuwait quotes in fils; binary floating
  point cannot represent a half-fil tick exactly and the error compounds through
  any aggregate.
- **`quotes.source` is part of the key**, so TradingView and the broker can both
  record the same minute. Their numbers legitimately differ, and collapsing them
  would hide that.
- **`orders.symbol` is nullable and not a foreign key.** An order whose symbol
  cell fails to parse still has a real id, price and quantity, and those stay
  reconcilable. The terminal only shows today, so a discarded row is gone.
- **`rows_extracted` and `rows_inserted` are recorded separately.** Equal numbers
  mean new data. Extracted without inserted means every row was already stored —
  a stalled feed wearing the appearance of a healthy one, which one counter
  cannot distinguish.

### Migrations

Applied in filename order, one transaction each, guarded by an advisory lock so
two processes cannot race. Applied files are checksummed: editing one after it
has run is reported as drift rather than passing quietly.

**To change the schema, add `002_*.sql`.** Never edit an applied migration.

---

## Checking it is working

```sql
-- last run per scraper
SELECT DISTINCT ON (scraper) scraper, status, started_at,
       rows_extracted, rows_inserted, error_message
  FROM scrape_runs ORDER BY scraper, started_at DESC;

-- rows collected today
SELECT source, count(*), count(DISTINCT symbol) AS symbols,
       min(minute_bucket), max(minute_bucket)
  FROM quotes WHERE trading_day = CURRENT_DATE GROUP BY source;

-- failures
SELECT scraper, started_at, error_message
  FROM scrape_runs WHERE status = 'FAILED'
  ORDER BY started_at DESC LIMIT 20;
```

`rows_extracted > 0` with `rows_inserted = 0` across a whole session means the
source is being read but nothing is new — check the feed before assuming success.

---

## Scraping runs off the main thread

The main thread owns the scheduler and the database pool. Scrapes run in
**worker threads** (`src/scrapeWorker.js`, managed by `src/scrapeWorkerHost.js`),
because a scrape is a long task driving a browser that occasionally hangs on a
page that never settles — and a scheduler that dies at 09:12 loses the rest of
the session silently.

Verified: the main thread's heartbeat ticked **24 times** during a scrape, and a
hung job is terminated on its own timeout rather than blocking anything.

**One persistent worker per source, not one per run.** A worker per minute would
mean launching Chromium per minute, and for AWSAT it would mean *logging in* per
minute against a terminal that locks the account after a few attempts a day.
That constraint decides the design: one worker per source, kept alive, holding
one browser and one session. Terminating an AWSAT worker costs a login, so it
happens only on a hard timeout — and the log says so.

Workers never touch the database. They return plain objects; the main thread
does every write, so there is one pool for the process rather than one per
thread.

## When TradingView returns no rows

### If you are using a private watchlist URL

`/watchlists/<id>/` is a **private** list. Without a session TradingView serves
the page shell — correct title, working tabs — and **no symbols at all**, because
it does not know whose watchlist to show. This looks exactly like a broken
selector and is not one, so the scraper now refuses up front with the fix:

```bash
npm run tv:login      # opens a window; log in by hand, press Enter
npm run tv:probe      # confirm the rows are now visible
```

A public page needs no login and is a valid alternative:

```
TRADINGVIEW_URL=https://www.tradingview.com/markets/stocks-kuwait/market-movers-all-stocks/
```


`TradingView returned no rows` has **five** different causes that all look
identical from the log, so don't start by editing selectors. Start here:

```bash
npm run tv:probe            # what the scraper sees, step by step
npm run tv:probe -- --headed  # watch it in a real window
```

The probe reports what each selector matched before and after dismissing
overlays, the column mapping it resolved, the first rows as they would be
stored, and it writes a **screenshot and the page HTML to `./tmp`**. The scraper
now saves the same artifacts automatically whenever a scrape fails.

**Open the screenshot first.** It distinguishes the five causes immediately:

| What the screenshot shows | Cause | Fix |
|---|---|---|
| A promo or cookie dialog | An overlay covered the board | Add its button text to `DISMISS_LABELS` in `src/browser/pageHelpers.js` |
| A login page | No session | `npm run tv:login` |
| A "verify you are human" page | Bot challenge | Run headed, or slow the cadence |
| An empty table with headers | Websocket never connected | Network or region restriction |
| A page that looks nothing like before | Layout changed | Use the probe's selector census to pick a new one |

### Saving a session

```bash
npm run tv:login            # opens a window; log in by hand, press Enter
```

Cookies are written to `secrets/tradingview-cookies.json` (gitignored, mode
0600) and applied automatically. The public market pages don't strictly require
a session, but an anonymous one is served more interstitials — and an overlay
covering the board is the most common reason a scrape returns nothing.

## Adapting the AWSAT selectors

The selectors in `src/scrapers/awsat.js` were written without access to the live
terminal. To correct them:

```bash
HEADLESS=false npm run run:once awsat.board
```

Watch the browser, inspect the real DOM, and update the `SELECTORS` object at the
top of the file. Prefer stable attributes (`data-*`, `id`, `role`) over CSS class
names — framework-generated class names change on every deploy, so a scraper
pinned to them is scheduled to break on someone else's release timetable.

The same applies to TradingView: `src/scrapers/tradingview.js` tries structural
selectors first (`table tbody tr`, `[role="row"]`) for that reason, and resolves
columns from header text rather than fixed positions, because a column added
upstream shifts everything to its right and silently rewrites the data.

---

## How data loss is prevented

This is the part worth understanding, because a trading minute **cannot be
re-scraped** — the source shows now, not five minutes ago.

- **A single bad row cannot destroy a batch.** A multi-row `INSERT` is one
  statement and therefore all-or-nothing. Measured before this was fixed: a
  batch of three rows containing one negative price stored **zero**, losing two
  valid rows. A failed batch is now retried row by row, the good rows land, and
  each rejection is logged with the offending values.
- **Rows are validated before insertion.** A nonsensical volume is nulled rather
  than costing the price on the same row; only a missing symbol, an unaligned
  minute bucket or an impossible price rejects a row outright.
- **A quote whose symbol failed to register is dropped, not offered.** One
  unknown ticker would otherwise fail its chunk and force the slow path.
- **`rejected` is reported at error level.** Extracted rows that reached neither
  the database nor a duplicate are lost data, and the run says so.
- **A stale-selector scrape fails loudly.** If fewer than half the rows carry a
  usable price, the run is marked `FAILED` rather than storing a board of nulls
  as a success.

## Error handling

- A failing job is caught, recorded in `scrape_runs` with its message and stack,
  and does not stop the scheduler. The next minute tries again.
- An uncaught exception exits **non-zero**, so a supervisor's restart policy
  actually fires. Exiting 0 after a crash tells systemd the work finished.
- A configuration mistake prints the variable that is wrong and exits, rather
  than a stack trace pointing at `config.js`.
- A job still running when its next tick arrives is skipped, not stacked — two
  copies would drive the same browser and each would read the other's page.
- The browser is relaunched automatically if it dies.
- One unreadable symbol during a depth sweep is logged and skipped; the rest of
  the sweep continues.
- `SIGTERM` / `SIGINT` stop the scheduler, close the browser, and drain the pool
  before exiting.
