# BACKEND — complete reference

**kse-scraper · 27 August 2026 · 29 migrations · 44 test suites**

Everything in this document was read from the codebase or queried against `kse`
on 27 August. Nothing is from memory.

---

## 0 · What BACKEND means here

| | |
|---|---|
| **BACKEND** | this Node application — `socket.99labs.space` |
| **SCRAPER** | the Tampermonkey userscripts in the browser |

They deploy separately. A BACKEND deploy does **not** update the userscripts,
and re-uploading a userscript does **not** change the API.

---

## 1 · CR status — every CR, including the four re-classified

### Built and verified on `kse`

| CR | What | Evidence |
|---|---|---|
| **CR-30** target tick bands | `tick_band_crossed` on `symbol_day` | migration 021 |
| **CR-33** print location flow | `bought_at_offer`, `sold_at_bid`, `pct_at_offer` | `symbolDayMetrics.movementBlock` |
| **CR-37** buyers per seller | `buyers_per_seller` on `symbol_minute` | migration 016 |
| **CR-38** telemetry | `scrape_runs`, 12 columns, written by every job **and** by ingest | `repositories.recordRun` |
| **CR-39** depth scheduler | `depth_watchlist`, 8 slots, 3 seeded for 30 Aug | migration 024 |
| **CR-40** forensics persistence | **BUILT AS DATA** — columns, not a table | `tiny_pct_up`, `up_moves_tiny`, `last_qty_p10/50/90` |
| **CR-41** funnel tape-check | **BUILT AS DATA** — computed per symbol-day | `tiny_pct_up`, up-only, volume-gated |
| **CR-60** instrument identity | `instruments` PK is `symbol`; 142 · 140 · 139 | migrations 026, 027, 029 |
| **CR-61** per-feed status | `broker_status` + `tv_status`, 5 values each | migration 027 |
| **CR-62** symbol master drift | master re-fetch + `unmatched` WARN | **SCRAPER + BACKEND** |
| **CR-63** close_source | 1,687 of 3,769 are the official close | migration 028 |
| **CR-64** prev_session reach-back | 30 Jul → 2 Aug, capped at 5 sessions | `computeSymbolDay.previousCloses` |
| **CR-65** analytics layer | `symbol_day` 94 cols, `market_day` 23 cols | migrations 011–029 |
| **CR-66** depth slots | 3 pre-day, 5 wake-up, 15s sweep | migration 024 |
| **CR-67** scrape_runs from ingest | quotes, depth, orders each write a row | `ingest.logRun` |
| **CR-68** double wall | **already built** — this is the `FROZEN` check | `signals.frozen` |

**CR-68 needed no work.** The spec — *both sides > 100k, volume zero* — is
`signals.frozen`, one of the seven, tested and wired into `fastLoop`. The
nightly scorer treats it as directionally neutral (`was_right = NULL`), because
a freeze makes no claim about which way price moves.

### Not built

| CR | Why |
|---|---|
| **CR-43** wall events | no persistence layer for wall add/pull history |
| **CR-46** auction capture | separate capture path, not started |
| **STEP6 sharia columns** | only source is an unverified social post — deliberately not built |
| **`position` writer** | out of scope; P&L computes from `net_value` directly |

### Stale references in the CR history

| | |
|---|---|
| **CR-42** load signal | reads `stock_daily` — should read `symbol_day` |
| **CR-42** close prices | its 21 July window has `close_source = TRADING`, not the official close |

---

## 2 · Database — 16 tables

`market_day_before_prevfix` is a snapshot, not part of the schema.

### Capture

| table | cols | holds |
|---|---|---|
| `awsat_market_quotes` | 28 | the broker board, one row per symbol per capture |
| `awsat_stock_depth` | 15 | the ladder — 10 levels, keyed on `captured_at` |
| `awsat_order_list` | 28 | one row per order, not per sighting |
| `tradingview_watchlist` | 13 | the TradingView feed |
| `tradingview_history` | 13 | daily OHLC |
| `client_submissions` | 8 | every POST from the userscripts |

### Reference

| table | cols | holds |
|---|---|---|
| `instruments` | 21 | the symbol registry — **PK is `symbol`** |
| `instrument_stake` | 4 | a group holding a stake in another group's symbol |
| `depth_watchlist` | 8 | **which symbol holds which slot today** |

### Analytics

| table | cols | holds |
|---|---|---|
| `symbol_day` | 94 | one row per symbol per session |
| `market_day` | 23 | one row per session |

### Live

| table | cols | holds |
|---|---|---|
| `symbol_minute` | 18 | one row per changed observation, per slotted symbol |
| `signal_log` | 18 | what fired — history, not state |
| `position` | 12 | **empty, no writer** |

### System

| table | cols | holds |
|---|---|---|
| `scrape_runs` | 12 | every job run and every ingest batch |
| `schema_migrations` | 4 | the ledger, with checksums |

---

## 3 · The rules that must not be "fixed"

These look like inconsistencies. Each is deliberate, and each came from a
specific error.

### Three filters, two columns

```
symbol_day        is_primary      history keeps a delisted stock
market_day        is_tradeable    breadth excludes it
/depth-symbols    is_tradeable    never sweep it
```

A symbol is **primary but not tradeable** for two distinct reasons — it sits on
the Auction Market, or it is DELISTED. Both are correct. `is_primary` is never
set false by either: BAREEQ keeps its 8 sessions in `symbol_day` and simply
stops counting in breadth.

### Two "5 session" rules that count differently

| rule | counts | why |
|---|---|---|
| `broker_status = ABSENT` | sessions **with data** | asks *did the symbol appear* |
| `prev_close` reach-back | sessions **with closes** | asks *was there a close* |

30 July had quotes for 134 symbols and produced zero closes. It counts for the
first rule and not the second.

### `superseded_by` and `DELISTED` are facts, never inferred

Set by hand. The nightly job never sets or clears them — except the DELISTED
re-quote flip, which fires **once from the nightly job** and stays **silent from
ingest**, because ingest would see the same event on every poll for a day.

Inferring supersession from missing quotes would eventually mark a suspended
stock as superseded by an unrelated one sharing a code. A silent wrong answer is
worse than a stale one.

### `market_changed_on` holds one transition

The most recent only. Prior movements are not retained: the move happens about
twice a year, and `symbol_day` records where prices stop and start, so the period
is reconstructable without a history table.

### The SQL session functions are not authoritative

`prev_session_sym`, `prev_session` and `session_close` are **convenience wrappers
for ad-hoc queries**. The rule that runs lives in
`src/jobs/computeSymbolDay.js`. The compute job stopped calling them per symbol
when the backfill took five minutes a day; it now runs one query with the rule
inlined and takes 787ms.

---

## 4 · Jobs — 13 registered

| job | schedule | writes |
|---|---|---|
| `tradingview.quotes` | `5 * 9-12 * * 0-4` | `tradingview_watchlist` |
| `tradingview.history` | `0 0 17 * * 0-4` | `tradingview_history` |
| `tradingview.backfill` | manual | `tradingview_history` |
| `awsat.board` | `15 * 9-12 * * 0-4` | SKIPPED when `AWSAT_MODE=client` |
| `awsat.depth` | `30 * 9-12 * * 0-4` | SKIPPED when `AWSAT_MODE=client` |
| `awsat.orders` | `45 * 9-12 * * 0-4` | SKIPPED when `AWSAT_MODE=client` |
| `signals.fast` | `*/20 * 9-12 * * 0-4` | `symbol_minute` **then** `signal_log` |
| `signals.wakeup` | `0 */15 9-12 * * 0-4` | `depth_watchlist` **and** `signal_log` |
| `daily.instruments` | `0 25 13 * * 0-4` | `instruments` |
| `daily.symbolday` | `0 30 13 * * 0-4` | `symbol_day` |
| `daily.marketday` | `0 40 13 * * 0-4` | `market_day` |
| `signals.score` | `0 45 17 * * 0-4` | `signal_log` (scores it) |
| `daily.analysis` | `0 15 8 * * 0-4` | RETIRED — returns SKIPPED |

**Order matters at 13:25–13:40.** `daily.instruments` runs first so the day's
rows are computed against a correct registry. `daily.marketday` runs last
because it reads what `daily.symbolday` wrote — and refuses if that table is
empty, rather than storing zeros that read as a flat market.

### `signals.fast` — write then compare

The writer is called **inside** the loop, not scheduled separately: two crons on
the same tick can drift, and the comparison would then run against a snapshot
that does not exist yet.

`extracted` is the **snapshot count**, not the symbols watched, so two failures
read differently in `scrape_runs`:

```
extracted 8, inserted 0   the loop is working, nothing fired
extracted 0, inserted 0   the writer is broken
```

An inert loop announces itself: first empty run logs the reason, run 20 WARNs
(~7 minutes), then every 180 (~hourly).

---

## 5 · The seven checks

Run per consecutive pair of `symbol_minute` rows. First match does not stop the
rest.

| # | signal | fires when |
|---|---|---|
| 10 | `NO_PROTECTION` | `bid_qty < 20,000` |
| 11 | `BUYERS_8_5` | ratio ≥ 1.6 **and price rising** |
| 12 | `WALL_PLACED` | offer grew, no volume |
| 13 | `WALL_PULLED` | offer fell, no volume |
| 14 | `BAIT_BID` | `bid_qty > 100k` and `bid_age_secs < 300` |
| 15 | `FROZEN` | **both sides > 100k, no volume** ← CR-68 |
| 16 | `BID_EMPTY` | a trade ≤ 100 shares moved price down |

Scored nightly at 17:45, direction-aware: rise signals are right if price rose
1+ fil at +5min, warning signals if it fell, `FROZEN` is `NULL` — it makes no
directional claim.

---

## 6 · API — 6 endpoints

| method | path | auth | notes |
|---|---|---|---|
| GET | `/health` | none | names the database it writes to |
| GET | `/depth-symbols` | none | reads `depth_watchlist`; **500** if the table is missing |
| POST | `/quotes` | token | writes `awsat_market_quotes` + `scrape_runs` |
| POST | `/depth` | token | writes `awsat_stock_depth` + `scrape_runs` |
| POST | `/orders` | token | writes `awsat_order_list` + `scrape_runs` |
| POST | `/debug` | token | diagnostic dumps |

Both `/ingest/*` and bare paths are mounted. CORS is applied at app level,
before body parsing — required for HTTPS→HTTP.

**`/depth-symbols` returns 500 rather than an empty list** when its table is
missing. An empty list at 08:59 is legitimate; an empty list because a table is
gone is a failure, and if the two look identical the failure stays invisible
until someone notices nothing was captured all day.

---

## 7 · Operational scripts

| script | purpose |
|---|---|
| `migrate-inspect.js` | read-only survey of a source database |
| `migrate-all.js` | the migration — `--from`, `--to`, `--only`, `--since`, `--apply` |
| `backfill-symbol-day.js` | `--from --to --apply`, one day at a time |
| `backfill-market-day.js` | same, **oldest first** — rolling windows read prior rows |
| `seed-instruments.js` | derive the registry from both feeds |
| `seed-depth-slots.js` | `--date --slots`, pre-day slots 1–3 only |
| `check-data.js` | duplicates, markets, registry, activity, depth, stale RUNNING |
| `fix-market-labels.js` | one symbol, one market — by weight of evidence |
| `fix-markets.js` | reports markets outside scope; **does not delete** |

**`migrate-all.js` runs a post-migration phase automatically:** ANALYZE, market
label repair, `instruments` seed, `executions_observed` from snapshots,
reconciliation against the source, then a list of anything still wrong.

---

## 8 · Deploy sequence

```
1.  deploy this code to socket.99labs.space
2.  confirm AWSAT_MODE=client
3.  change DATABASE_URL to kse
4.  curl -s https://socket.99labs.space/ingest/health
```

**Deploy before repointing.** Migration 019 changed the depth unique key to
`(symbol, level, captured_at, ingest_source)`. Pre-019 code targets
`created_at`, so repointing first makes every depth insert fail while quotes and
orders keep working — which reads as a partial outage rather than a version
mismatch.

`scrape_runs` stays near zero until this is done.

### Separately — the SCRAPER

Three changes are in the package and need re-uploading to Tampermonkey. They do
**not** ship with a BACKEND deploy:

| file | change |
|---|---|
| `awsat-capture.user.js` | master re-fetch — the eight-day gap fix |
| `awsat-capture.user.js` | sends `unmatched` so the server can name dropped symbols |
| `awsat-depth-all.user.js` | 15s sweep of 8, budget 55s → 13s |

---

## 9 · Limitations and open work

Two different things, and reading them in one list made an approved fix look
like a permanent state.

```
KNOWN LIMITATION     decided to live with this
OPEN                 approved, not built
```

### Known limitations

| | |
|---|---|
| `bid_orders` / `offer_orders` | absent from the source; may not be obtainable at all |
| 45% of closes are official | 1,260 rows carry a `TRADING` close from the 12:59 capture window |
| `market_changed_on` | one transition only; prior movements not retained |
| Synthetic order ids | identical orders in the same second collapse into one |
| No transactions in `migrate-all` | each chunk autocommits; a crash leaves a partial table, safe to re-run |
| `position` | no writer; P&L computes from `net_value` directly |

### Open

| | |
|---|---|
| `writeSymbolMinute` cumulative volume | held in process memory; a restart gives one tick of `volume_delta = null`. The three volume-keyed checks go SILENT on that tick, not false — verified |

### Closed this session

| | was | now |
|---|---|---|
| **Three checks could never fire** | `signals.js` read `volume`, a column `symbol_minute` does not have | reads `volume_delta`; 7 of 7 fire |
| `is_tradeable` inert | nothing read it | filters `market_day` breadth and `/depth-symbols` |

**The lesson from the first, written down because it has now happened twice:**

```
A test that constructs its own input proves the logic.
It proves nothing about the wiring.
```

Both times — `sighting_count` and this — it was caught by running against real
data, not by reading. `signals.test.js` now builds its fixture from
`information_schema`, and a fixture that uses a property the table does not have
throws rather than passing.

## 10 · Verified state, 27 August

```
awsat_market_quotes   954,845 rows · 142 symbols · 0 duplicates
awsat_stock_depth      81,978 rows · prices + captured_at
awsat_order_list          116 orders · sighting_count max 261
instruments               142 · 140 primary · 139 tradeable
symbol_day              3,769 rows · 140 symbols · 28 sessions
market_day                 28 rows
depth_watchlist             3 rows · seeded for 30 Aug
scrape_runs                 2 rows · fills on repoint
symbol_minute               0 · writer wired, waits on Sunday
signal_log                  0 · waits on Sunday
position                    0 · no writer
```

**44 test suites, 0 failed.**
