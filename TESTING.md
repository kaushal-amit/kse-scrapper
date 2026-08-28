# Testing procedure

Run in order. Each step has one command and one thing to look for.

**Before anything:** `npm test` must be green. It runs all 8 suites in separate
processes — they share module state (login guard, browser pool, worker threads)
and contaminate each other in-process.

```
8 passed, 0 failed, 0 skipped
```

---

## 0 · Database

```bash
npm run setup          # create the database and apply all migrations
npm run migrate:status # should say nothing pending
```

Expect **10 tables** and **3 views**. Anything superseded by the source split was dropped in migration 008. Confirm the six that matter:

```sql
\dt tradingview_watchlist tradingview_history daily_stock_analysis
\dt awsat_market_quotes awsat_stock_depth awsat_order_list
```

---

## 1 · TradingView — server side (the only side)

TradingView has **no client-side collector**. Everything comes from Chromium.

```bash
npm run tv:login       # once — opens a window, log in by hand, press Enter
npm run tv:probe       # confirms the session and the row selectors
npm run run:once tradingview.quotes
```

**Look for:** `extracted=137 inserted=137 rejected=0`

```sql
SELECT symbol, last_price, change_pct, volume, avg_volume, market_cap
  FROM tradingview_watchlist ORDER BY created_at DESC LIMIT 5;
```

Every column populated. `last_price` must be a **number, not null** — a board of
nulls means the cell ids moved, and the error will name the ones actually on the
page.

**If it fails:** the message distinguishes an expired session (`tv:login`) from
moved selectors (`TV_QA_*`). It will not report one as the other.

### History — testing it by hand

History is NOT scraped. It aggregates the minute rows already collected, so it
needs captures to exist first:

```bash
npm run run:once tradingview.quotes    # a few times, a minute apart
npm run run:once tradingview.history
```

**If it says `too few captures to form a bar`, that is the guard working.** A
symbol seen 3 times has no meaningful high or low. To test with what you have:

```bash
HISTORY_MIN_CAPTURES=2 npm run run:once tradingview.history
```

Any past day can be re-finalised, which is how to test without waiting:

```bash
npm run run:once tradingview.history -- --date=2026-08-24
npm run run:once daily.analysis     -- --date=2026-08-24
```

Re-running either is safe — both UPSERT, so a second run corrects the row
rather than duplicating it.

```sql
SELECT symbol, trade_date, open_price, high_price, low_price, close_price,
       change_pct, session_finalised_at
  FROM tradingview_history ORDER BY trade_date DESC LIMIT 5;

SELECT symbol, day_open, day_close, day_range, total_swings, bull_swings,
       vol_spike_count, buyer_pct, seller_pct, best_earning_time
  FROM daily_stock_analysis ORDER BY trade_date DESC LIMIT 5;
```

`high_price >= low_price` on every row — the constraint enforces it, so a
violation means the parser crossed two columns.

---

## 2 · AWSAT — server side

**Must run headed.** Login stalls headless with no error; the scraper refuses
rather than spending one of two daily login attempts on a mode that cannot work.

```bash
npm run awsat:login-state     # check the budget BEFORE anything
```

`attemptsLeft` should be 2 and `lockedOut` no. If it is locked, it prints why —
a timeout means a false positive, and `-- --reset-lockout` clears it.

```bash
HEADLESS=false xvfb-run -a --server-args="-screen 0 1280x800x24" \
  npm run run:once awsat.board
```

**Look for:** `awsat: login submitted {via: ...}` then `board read from socket`
or `market swept`.

```sql
SELECT market, count(*), count(DISTINCT symbol)
  FROM awsat_market_quotes WHERE trading_date = CURRENT_DATE GROUP BY market;
```

Both **Premier Market** and **Main Market** present. One market only means the
dropdown did not switch — the scraper refuses to store one market's rows under
another's name, so you get a gap rather than corruption.

### Socket vs DOM

With `AWSAT_BOARD_MODE=both`, one log line settles which collector is complete:

```
awsat: SOCKET vs DOM comparison { socketSymbols, domSymbols, onlyInSocket, ... }
```

If the socket returns ~137 across both markets and the DOM returns fewer, set
`AWSAT_BOARD_MODE=socket` and the scrolling, blind-band and dropdown problems
stop existing.

---

## 3 · Stock depth

**Read this before judging the result.** Full depth for 135 symbols inside 90s
is not achievable through this terminal: switching to a symbol and waiting for
its ladder costs ~1s, so a full DOM sweep needs 2–3 minutes. The terminal renders
one ladder at a time.

What meets the ceiling is **level 1 for all 135 from the socket** — the quote
frames carry best bid/offer for every symbol continuously. Measured: 0.5 ms for
135 symbols.

```bash
DEPTH_SYMBOLS=ABAR,ZAIN,NBK HEADLESS=false xvfb-run -a npm run run:once awsat.depth
```

Server side sweeps the configured shortlist. Keep it to **3 symbols or fewer** —
at ~30s each, more breaches the ceiling and `awsat_depth_freshness` will say so.

```sql
SELECT * FROM awsat_depth_freshness WHERE status <> 'OK';   -- OK/LATE/BREACH
SELECT * FROM awsat_depth_gaps;                             -- stalls that resumed
```

The second matters: age alone cannot see a sweep that stalled for five minutes
and then caught up.

---

## 4 · Order list

```bash
HEADLESS=false xvfb-run -a npm run run:once awsat.orders
```

```sql
SELECT order_id, symbol, side, order_status, quantity, filled_quantity
  FROM awsat_order_list ORDER BY created_at DESC LIMIT 10;
```

**The check that matters:** `order_id` must look like an order id. If it holds a
company name and `symbol` holds a price, the reader found the wrong grid — that
is exactly what the positional reader used to do. There is no fallback now, so
it fails loudly instead.

An empty order list is a normal result, not a failure.

---

## 5 · AWSAT — client side (Tampermonkey)

The server never sees your broker credentials; the script runs inside the
session you authenticated by hand.

```bash
INGEST_TOKEN=<24+ random chars> npm start     # API is OFF without a token
```

Install both userscripts, set `SERVER` and `TOKEN` in each to match:

| script | what it sends | cadence |
|---|---|---|
| `awsat-capture.user.js` | quotes, all symbols | 60s |
| `awsat-depth-all.user.js` | level 1 all symbols + rotating full ladder | 60s / 3s |

**Look at the on-page panel**, not the console:

- `master rows: N (full)` — "partial" means the full symbol list has not arrived
  and whole markets will be missing
- `L1 (all symbols): 135`
- `Ladder rotation: n/135` — climbs to 135, then restarts
- `retry queue: 0`

### The 135-in-90s check

Press **"Log message types"**. Then:

```sql
SELECT count(DISTINCT symbol) AS symbols,
       max(created_at) - min(created_at) AS spread
  FROM awsat_stock_depth
 WHERE level = 1 AND ingest_source = 'awsat_client'
   AND created_at > now() - interval '2 minutes';
```

**Pass:** `symbols` ≈ 135 and `spread` under 90 seconds. All 135 share one
`capturedAt` because they come from a single socket pass, so the spread is the
posting time, not a sweep.

If the console shows a **message type other than the quote type**, depth may be
available for every symbol in one pass — send it and the rotation becomes
unnecessary.

---

## 6 · API and reconciliation

```bash
curl -H "Authorization: Bearer $INGEST_TOKEN" localhost:8787/ingest/health
```

Then confirm both collectors coexist rather than overwrite:

```sql
SELECT ingest_source, count(*) FROM awsat_market_quotes
 WHERE trading_date = CURRENT_DATE GROUP BY ingest_source;

SELECT symbol, last_price, ingest_source FROM canonical_quotes LIMIT 5;
```

Both `awsat_server` and `awsat_client` should appear in the first query — they
are separate observations, kept. `canonical_quotes` picks one per symbol per
minute by precedence (client 2 > server 1) with the freshest capture breaking
ties. **Nothing is deleted**, so a disagreement stays inspectable.

---

## 7 · Health check for a full session

```sql
SELECT scraper, status, rows_extracted, rows_inserted, error_message
  FROM scrape_runs WHERE trading_date = CURRENT_DATE ORDER BY started_at DESC;
```

`rows_extracted > 0` with `rows_inserted = 0` across a whole session is the one
to act on: the source is being read and nothing is new. That is a stalled feed
wearing the appearance of a healthy one, and one counter cannot tell them apart.

---

## Known limits

| | |
|---|---|
| Full depth, 135 symbols, 90s | **Not possible** via the terminal. L1 for all meets it; full ladders rotate on a ~7-minute cycle. |
| `daily_stock_analysis` | Table matches the spec exactly. **Calculations not implemented** — no formulas were given. |
| Depth/orders over the socket | Unproven. `npm run awsat:discover` settles it in one run. |
| AWSAT selectors | Taken from your working userscripts. Never executed against the live terminal from here. |
| `.env` selectors | **Quote anything starting with `#`** — dotenv reads it as a comment and silently uses the default. |


---

## Automatic schedule

| job | when | what it does |
|---|---|---|
| `tradingview.history` | **17:00**, Sun–Thu | finalises the day's bars from its minutes |
| `daily.analysis` | **08:15**, Sun–Thu | analyses the PREVIOUS trading day |

Both refuse to run inside the trading window, so a mistimed cron cannot analyse
a half-finished day and store it as final. `daily.analysis` steps back over the
weekend — run on Sunday morning, it analyses Thursday.

Override with `HISTORY_CRON` / `ANALYSIS_CRON`. If either lands inside the
window the scheduler says so at startup, rather than silently skipping every
day.


---

## Building up captures for history / analysis

History and the analysis AGGREGATE minute captures. One quotes run gives one
price per symbol, and one price has no range — no high, no low, no swings. That
is why a single run followed by history reports *too few captures*.

```bash
npm run collect -- --job=tradingview.quotes --minutes=15
npm run run:once -- tradingview.history
npm run run:once -- daily.analysis --date=<today>
```

**Through npm, the job name must come AFTER `--`.** npm swallows arguments
placed before its own separator:

```bash
npm run run:once -- tradingview.history --date=2026-08-24   # right
npm run run:once tradingview.history -- --date=2026-08-24   # npm eats the flag
```

`runOnce` now logs the date it resolved, so a flag that fails to arrive is
visible rather than looking like a job that ignored it.

---

## Testing AWSAT client-side, independently

```bash
AWSAT_MODE=client INGEST_TOKEN=<24+ chars> npm start
```

Server-side AWSAT jobs now report `SKIPPED` with the reason, and no login
attempt is spent. Install the three userscripts, setting `SERVER` and `TOKEN`
in each:

| script | posts to | cadence |
|---|---|---|
| `awsat-capture.user.js` | `/ingest/quotes` | 60s |
| `awsat-depth-all.user.js` | `/ingest/depth` | 60s L1 + 3s ladder |
| `awsat-orders.user.js` | `/ingest/orders` | 60s |

Confirm the server is in the right mode before anything else:

```bash
curl -H "Authorization: Bearer $INGEST_TOKEN" localhost:8787/ingest/health
# {"awsatMode":"client","acceptingClientData":true}
```

Then watch each panel, and check the database:

```sql
SELECT ingest_source, count(*), max(created_at)
  FROM awsat_market_quotes WHERE trading_date = CURRENT_DATE GROUP BY 1;

SELECT count(DISTINCT symbol) FROM awsat_stock_depth
 WHERE ingest_source = 'awsat_client' AND level = 1
   AND created_at > now() - interval '2 minutes';

SELECT order_id, symbol, side, order_status FROM awsat_order_list
 WHERE ingest_source = 'awsat_client' ORDER BY created_at DESC LIMIT 10;
```

**With `AWSAT_MODE=server` the API returns 409** to any client post, so a
userscript left running cannot contribute. The mode cannot be half-applied, and
`AWSAT_MODE=both` is rejected at startup.


---

## Depth capacity — how many stocks fit in a minute

**Level 1, all symbols: every minute, always.** It comes from the price socket,
not the UI — measured at 0.50 ms for 135 symbols.

**Full ladder: ~40 symbols per minute.** Each one costs ~0.92s:

| step | cost |
|---|---|
| set the search box + Enter | 0.25s |
| wait for the ladder to repaint | 0.60s |
| read the `.pos-rel` rows | 0.05s |
| post (batched) | 0.02s |

55 usable seconds ÷ 0.92s = 59 at best; **~40 with the margin a slow repaint
needs.** That margin is not optional: a repaint slower than the wait hands you
the *previous* symbol's book under the new name, and those rows look valid.

Set your list in `awsat-depth-all.user.js`:

```js
var LADDER_SYMBOLS = ['ABAR','ZAIN','NBK','KFH'];   // empty = rotate everything
```

The sweep stops at a 55s budget and reports which symbols it did not reach, so
a list that is too long is visible rather than silently partial. Names not on
the board are listed separately.

```sql
SELECT * FROM awsat_depth_freshness WHERE status <> 'OK';
```

---

## Orders never duplicate

Keyed on `order_id` alone and upserted, so ten orders are ten rows however
often the scraper runs. Verified: 10 orders × 30 scrapes = **10 rows**.

```sql
SELECT order_id, order_status, filled_quantity, sighting_count,
       first_seen_at, last_seen_at
  FROM awsat_order_list ORDER BY last_seen_at DESC;
```

`sighting_count` climbs while the row count does not. A fill updates the row in
place — the status advancing to FILLED is the whole point of watching it.

`ingest_source` is deliberately **not** in the key: the same order seen by both
collectors is one order, and keying on the collector would recreate the
duplication as two rows that look like two orders.


---

## If the log says `ingest rejected: bad token`

The token in the userscript and `INGEST_TOKEN` on the server must be identical.
The uploaded scripts use:

```js
var AUTH_TOKEN = 'trading';
```

so the server needs `INGEST_TOKEN=trading` — or change both together. The 401
now reports which mechanism carried the token and how long it was, so a
mismatch is distinguishable from nothing being sent at all.

Confirm before installing anything:

```bash
curl -X POST localhost:8787/ingest/depth \
  -H 'Content-Type: application/json' \
  -d '{"token":"trading","records":[]}'
```

A 401 means the token is wrong. A 200 means auth is fine and any later failure
is about the payload.


---

## `NetworkError when attempting to fetch resource`

The request never reached the server, so the server log shows nothing. Two
causes, and they are usually both present:

**1. CORS.** The userscript runs on `https://www.awsatbroker.com` and posts
cross-origin. The API now sends the headers and answers the `OPTIONS` preflight
before auth — a 401 on the preflight means the POST never happens at all.

**2. Mixed content — CORS does not fix this.** An `https://` page may not fetch
`http://`. Chrome exempts `http://localhost`; **Firefox does not.** Pick one:

- run the browser as Chrome and point `BASE` at `http://localhost:8787`
- or serve the API behind the https host the scripts already use
- or put any TLS terminator in front of it

Check reachability from the terminal's own console, on the broker page:

```js
fetch('http://localhost:8787/ingest/health', {headers:{Authorization:'Bearer trading'}})
  .then(r => r.json()).then(console.log).catch(console.error)
```

`{"ok":true,"awsatMode":"client","acceptingClientData":true}` means the path is
clear. A `NetworkError` here is transport, not payload — and no amount of
changing the JSON will help.

**Avoid the preflight entirely** by sending `Content-Type: text/plain`. That
makes it a simple request: one round trip, nothing to misconfigure. The API
parses it as JSON either way.


---

## Depth data belonging to the wrong stock

The search box updates the moment you type; the book arrives over the socket
afterwards. Reading between those two moments gives the PREVIOUS stock's numbers
under the new stock's name — and every row looks valid.

The client now requires three things before it posts, all of them:

1. the depth widget's **own** label reads the requested symbol (not the search box)
2. the ladder is non-empty
3. it has been **stable across two consecutive reads**

(3) matters as much as (1): the widget clears its rows before refilling them, so
"the book changed" fires on a half-drawn ladder. Verified against a fixture that
reproduces the real timing — label instantly, empty at 200 ms, book at 700 ms.

When it gives up, the panel says which condition failed:

```
last skip: widget still showing ABAR, wanted ZAIN
```

That distinguishes a slow terminal from a wrong selector, which "skipped" alone
never could.

## If depth returns a CORS error but quotes work

CORS now sits **before** body parsing. It used to live inside the ingest router,
which is too late: `express.json` rejects an oversized or malformed body before
any router runs, and that response carried no `Access-Control-Allow-Origin` — so
the browser reported a CORS error for what was really a **413**. Depth is the
largest payload, which is why depth showed it.

413, 400, 401 and 409 all carry the headers now, so the real status is readable:

```json
{"ok":false,"error":"payload larger than 8mb — raise INGEST_BODY_LIMIT or send smaller batches"}
```


---

## `404 Not Found` on /depth

The userscripts post to `/depth`, `/quotes`, `/orders` and `/debug`; the API was
mounted only under `/ingest`. It now serves **both**, so neither side has to be
edited:

```
/depth          /ingest/depth
/quotes         /ingest/quotes
/orders         /ingest/orders
/debug          (new — the HTML dumps the scripts send on a selector failure
                 were 404ing silently, throwing away the one artifact that
                 explains the failure)
```

Debug dumps land in `./tmp/client-*.txt`.

## The 135-stock consistency check

Every cycle, on both collectors, AWSAT's symbol set is compared against the
TradingView watchlist for the day. TradingView is the reference — it is the
curated list, while the broker board is whatever the terminal happened to show.

The response carries it:

```json
{"inserted":133,"coverage":{"expected":135,"matched":131,"missing":4,"pct":97}}
```

and missing tickers are **listed**, not just counted — "4 missing" cannot be
acted on, four symbols can:

```
WARN  AWSAT is missing symbols the TradingView watchlist has
      { expected: 135, matched: 131, missing: 4,
        missingSymbols: ['ALAFCO','SOKOUK','INJAZZAT','ACICO'] }
```

Symbols AWSAT has and the watchlist does not (rights, REITs, indices) are
reported at info level — worth seeing, not an error.

**Reported, never blocking.** A short capture is still stored; refusing it would
turn a reporting problem into data loss.

```sql
-- what AWSAT missed today
SELECT symbol FROM tradingview_watchlist WHERE trading_date = CURRENT_DATE
EXCEPT
SELECT symbol FROM awsat_market_quotes WHERE trading_date = CURRENT_DATE;
```


---

## Market coverage

```sql
SELECT market, count(DISTINCT symbol) AS symbols
  FROM awsat_market_quotes WHERE trading_date = CURRENT_DATE GROUP BY market;
```

Expect exactly two rows — **Premier Market ~39, Main Market ~98** — totalling the
TradingView list. A third market, or a single-letter value like `B`, means a raw
MARKET_ID escaped the name map; those are now rejected at validation with the
code quoted.

`Auction Market` symbols are excluded by default: they carry zero prices and a
null session. Set `AWSAT_KEEP_MARKETS` to include them if ever needed.


---

## Depth capturing the wrong stock's book

The cause was **how the symbol was selected**, not how the book was read.

Typing and pressing Enter takes whatever the dropdown has highlighted — a
rights line, a "Buy In Market" entry, or the same name on another market. When
it matches nothing, the previous book simply stays on screen while the search
box already shows the new name.

The client now searches, waits for the results popup, and clicks the row that
matches **symbol AND code AND a real market**, refusing `BUY IN` outright and
skipping zero-size (stale) rows. Selection is by **mousedown** — these dropdowns
commit on mousedown, and a plain click arrives after the input has blurred.

Verified 10/10 against the ambiguous rows that cause it:

```
ABAR - 633  Buy In Market                  <- refused
ABARRE - 634  Rights  Main Market          <- refused (code mismatch)
ABAR - 633  AL ARABI GROUP  Main Market    <- selected
```

No match means the symbol is **skipped**, never posted with a stale book.

### Choosing the stocks

```bash
DEPTH_SYMBOLS=ABAR,ZAIN,NBK,KFH      # order is priority
DEPTH_MAX_SYMBOLS=40                 # ~0.9s each; 40 fits a minute
```

```bash
curl localhost:8787/depth-symbols
# {"symbols":[{"symbol":"ABAR","code":"633"},...],"source":"DEPTH_SYMBOLS"}
```

Unset, it serves the day's watchlist capped at `DEPTH_MAX_SYMBOLS` and says so
(`"capped":true`) rather than handing over a list that cannot finish.


---

## Depth full of level-1 zeros

If `awsat_stock_depth` looks like this:

```
symbol       level  bid     bid_qty  offer   offer_qty  bid_orders
HUMANSOFT      1    0.0000     0     0.0000      0        [null]
IFAHR          1    0.0000     0     0.0000      0        [null]
```

**every row level 1, every value 0, `bid_orders` null** — that is the
socket level-1 path, not the ladder scraper. Two things follow:

- a level with no bid, no offer and no quantity is not a book, it is the absence
  of one. The socket reports 0 for a symbol with no live market: outside hours,
  suspended, or never subscribed.
- the DOM ladder path has contributed **nothing**. Its rows would carry levels
  above 1 and a populated `bid_orders`.

Empty books are now refused at the API and never sent by the client. They are
counted separately, because "no live market" and "broken payload" need
different responses:

```json
{"inserted":0,"rejected":0,"emptyBooks":8}
```

A whole batch of them logs a warning rather than silently storing nothing.

**Clean up what is already there:**

```sql
DELETE FROM awsat_stock_depth
 WHERE COALESCE(bid,0)=0 AND COALESCE(offer,0)=0
   AND COALESCE(bid_qty,0)=0 AND COALESCE(offer_qty,0)=0;
```

**Then check the ladder path is running at all:**

```sql
SELECT max(level) AS deepest, count(*) FILTER (WHERE bid_orders IS NOT NULL) AS with_orders
  FROM awsat_stock_depth WHERE trading_date = CURRENT_DATE;
```

`deepest = 1` and `with_orders = 0` means only the socket path is contributing
and the ladder sweep is not reaching any symbol — check the panel's
`last skip:` line for which condition is failing.


---

## Installing the userscripts after an update

The server rejecting bad rows is only half the fix — the client has to stop
sending them. If the log shows

```
ingest: depth accepted {"offered":194,"inserted":0,"emptyBooks":194}
```

then **194** symbols were sent, which includes the 57 auction ones. A current
script sends neither: it filters to Premier + Main and skips symbols with no
book. That means the running userscript predates the fix.

Tampermonkey does not update a script you pasted in. Replace the body of each
from `userscript/` and save:

| script | check it is current |
|---|---|
| `awsat-capture.user.js` | quotes offered ≈ 137, not 194 |
| `awsat-depth-all.user.js` | panel shows `N with a book, M empty (skipped)` |
| `awsat-orders.user.js` | panel shows `posts:` climbing |

## Reading the coverage line

```
symbol coverage complete {"symbols":194}
```

That was wrong and is now impossible. The reference is **TradingView's own
captures** — never the `instruments` registry, which AWSAT also writes to, so
the check was comparing AWSAT against itself and could only ever pass.

Before TradingView's first run of the day it uses the **previous session's**
watchlist and says so:

```
INFO  using the previous session's watchlist as the reference
      { referenceDay: '2026-08-24', symbols: 137 }
```

With no TradingView data at all, the check is **skipped** and says so, rather
than inventing a reference.


---

## `NS_ERROR_CONNECTION_REFUSED` on localhost:8787

In the Network tab:

```
🚫 GET  localhost:8787/depth-symbols   NS_ERROR_CONNECTION_REFUSED  0 B
🚫 POST localhost:8787/depth           NS_ERROR_CONNECTION_REFUSED  0 B
   200 www.awsatbroker.com/...         everything else fine
```

**Connection refused is a TCP refusal, not CORS and not mixed content** — those
produce different errors. Nothing is listening on 8787 from the browser's point
of view. Check, in order:

```bash
netstat -ano | findstr :8787      # is anything bound?
curl http://localhost:8787/ingest/health
```

If `npm start` is running and curl works but the browser still refuses, the
browser is resolving `localhost` differently (IPv6 `::1` vs `127.0.0.1`) — point
the userscript at `http://127.0.0.1:8787` instead.

## `ladder sweep: 0/140 — RAN OUT OF TIME on 130`

This was my bug. When `/depth-symbols` could not be fetched, an empty list meant
**sweep everything** — ~140 symbols at ~1s each against a 55s budget, so 130
were never attempted and the sweep captured nothing.

An unreachable list now falls back to a **small named set** that finishes:

```js
var FALLBACK_SYMBOLS = ['NBK','KFH','ZAIN','GBK','ABK','BOUBYAN','KIB','BURG'];
```

0 of 140 is strictly worse than 8 of 8. The panel says which list is in use:

```
list: FALLBACK (8) — server unreachable
```

## `no matching result row`

Two changes. The **code is now a tiebreak, not a requirement** — a row that does
not print the code, or prints it differently from the master, no longer causes
the symbol to be skipped every cycle. And matching is on a **whole token**, so
`ABARRE` cannot satisfy a search for `ABAR`.

When it still fails, the panel says what the popup contained:

```
last skip: FACIL: no match — the results popup never opened
last skip: FACIL: no match — popup had 4 row(s), none naming it; saw: ...
```

Those need different answers: the first is a timing or selector problem on the
popup, the second means the terminal calls the stock something else.


---

## Order List vs Order Search

They are **tabs of the same widget** (`id="orderList-…"`), so matching the
widget id alone reads whichever tab happens to be showing. The scraper now
confirms the active tab reads *Order List* before touching a cell, and says so
when it does not:

```
· the "Order Search" tab is active — switch to Order List
```

That is actionable; "order list is empty" was not.

### The grid scrolls

```html
<div class="antiscroll-inner" style="height:220px">
  <div class="lazy-list-container" style="height:350px">
```

350px of rows in a 220px viewport — only about **nine rows exist in the DOM at
once**. The scraper scrolls the grid, collects each screenful, deduplicates by
order id, and restores the original scroll position. Without that, a trader
with twenty orders had eleven invisible to the scraper and the capture looked
complete.

### Values come from `title`, not the cell text

```html
<div cell-id="clOrdId" title="26082560133">
  <span>26082560133</span>
```

The visible text is ellipsised when the column is narrow, and **a truncated
order id is a different id** — which would defeat the deduplication entirely.
The title attribute carries the full value and is preferred.

Verified 19/19 against the widget HTML: both blocks joined by `top`, all nine
mapped fields, truncation, id-less rows dropped, and three scroll passes still
yielding two orders rather than six.


---

## Only some Order List rows saved (10 of 13)

Not a batch limit — **10 is the virtualisation window.** Your widget renders
`top:0px` through `top:225px` and nothing else exists in the DOM:

```
lazy-list-container  350px of rows
antiscroll-inner     220px viewport
row height            25px
```

Two faults compounded:

**The step was almost the whole viewport.** 0.8 × 220px = 176px gives only two
scroll positions and under two rows of overlap. The step now follows the
measured row height (two rows, ~50px), so consecutive windows overlap by six
rows or more — the same rule as the board scraper's blind band.

**One read per position.** The window re-renders asynchronously, so the read
straight after a scroll can still be the *previous* window. Counting that as
"nothing new" ended the scan while rows were unvisited. Each position is now
read twice, and the scan stops only after **three consecutive positions produce
no new order id** — reaching the bottom says where the scrollbar is; finding
nothing new says the work is done.

Verified 12/12 against a grid modelling the real widget **including render
lag**: the shipped behaviour reproduces exactly `10 of 13`, the fix finds all
13, and 20/50/137-row lists complete. Each half of the fix alone still falls
short on a long list.

The panel reports the scan:

```
scan: 13 row(s) over 9 step(s)
```

If that count is lower than the orders you can see, send it — the step count
distinguishes "stopped early" from "never scrolled".


---

## Only depth level 1 captured

Two separate causes.

**1. The reader looked in one container.** Your working script gathers several
candidate scopes — the quote-page row, plus any table whose header says
Bid/Offer/Ask — reads each, and keeps the one with the **most levels**. Mine had
been reduced to a single `querySelector`. If that container holds only the touch
while the full ladder sits in another widget, one scope gives 1 level where the
search would have given 5. Restored, and the panel now reports it:

```
deepest book seen: 5 level(s)
```

**2. The socket was writing the touch into the depth table.** Best bid/offer is
**already** stored in `awsat_market_quotes` as `bid`/`bid_qty`/`offer`/
`offer_qty`. Writing it again as depth level 1, for every symbol every minute,
adds no information and makes a ladder sweep that never ran look exactly like
one that works.

`POST_L1_AS_DEPTH` is now **off**. `awsat_stock_depth` holds ladders; if it is
empty, that is visible rather than disguised.

### Depth is not hardcoded

The reader takes as many levels as the book has, capped only by the database
ceiling of 20. A fixed 5 or 10 would silently discard levels on a deeper book.

Verified 16/16 including the five-level book from your screenshot — interleaved
bids and offers, sorted per side, zipped by position so level 1 is the touch on
both sides — a 12-level book yielding 12, a 30-level book capped at 20, and a
shallow scope losing to a deep one regardless of which is found first.

```sql
SELECT symbol, count(*) AS levels, max(level) AS deepest
  FROM awsat_stock_depth WHERE trading_date = CURRENT_DATE
 GROUP BY symbol ORDER BY deepest DESC LIMIT 10;
```

`deepest = 1` across the board now means the ladder path is genuinely not
running — check the panel's `deepest book seen` and `last skip` lines.


---

## The ladder never reached the API at all

The order-ticket HTML shows why. The ladder sits in its own bare widget:

```html
<div class="widget_new border-none" style="height:132px">
  <div class="nano quote-page-second-row-wght">
      Quantity | Bid          Offer | Quantity
```

**Nothing in it names a stock.** The verification looked for
`.symbol-fore-color` inside that widget — a class that actually lives on the
search *input*, one widget up. So the symbol came back null every time, the
"does this book belong to the stock I asked for?" check never passed, and every
symbol was skipped as *book never loaded*. Only the socket's level-1 rows ever
reached the table, which is what made it look like "level 1 only".

The symbol is in the order ticket's header:

```html
<div class="layout-inline pad-s-l mgn-l-r">New Order - ABAR - 633</div>
```

That is now the source, with the search box as a fallback. The header is
preferred because it changes only once the terminal has **accepted** the
selection, while the input echoes whatever was typed — the difference between
"this book is ABAR's" and "someone typed ABAR".

### The book in that snapshot is 13 levels, not 1

```
bids:    1   224 @ 120
offers: 13   227 @ 65,000  …  243 @ 82,220
```

Level 1 carries both sides; levels 2–13 are offer-only with `bid = null`. A
reader that stopped where the shorter side ended would report one level and be
wrong by twelve.

Verified 14/14 against that exact book, plus the symbol source: header wins over
a half-typed search box, falls back to the input, and the ladder widget alone
yields nothing — the old bug, now asserted.

### Markets

`/depth-symbols` now joins on `instruments.market` and serves **Premier and Main
only**. Sweeping auction symbols spent the minute's budget on books that never
load.


---

## Session rules (TMI Engine 01)

Two of the six rules are implemented as database functions, so the close and the
previous session are computed one way everywhere. A rule reimplemented per
caller is a rule that will eventually disagree with itself.

```sql
SELECT session_close('TIJARA', '2026-08-13');           -- 176, not 172
SELECT prev_session('TIJARA', '2026-08-13');            -- the previous session
                                                        -- WITH DATA
```

**Rule 1 — the close comes from all sessions**, not `session = 'Trading'`.
Filtering to continuous trading cuts off the closing auction and reads the last
continuous trade as the close: TIJARA 172 instead of 176. A NULL session is
included — an unlabelled print is more likely a capture gap than a print that
should be excluded.

**Rule 2 — `prev_session()`, never `trade_date - 1`.** Subtracting a day lands
on a weekend, a holiday, or a session that was never captured, and the
comparison is then against nothing. 29–30 July were missing and `date - 1` made
a change 6 fils wrong.

Verified 11/11 including both original errors reproduced: the old
`'Trading'`-only query still returns 172, and `date - 1` still returns NULL
across the July gap.

### Not yet implemented

`symbol_day` — the 90-column replacement for `daily_stock_analysis`. The DDL
exists in the TMI Engine 01 conversation and is not in this one. The remaining
four rules (tiny_pct_up up-only, print location over the tick rule,
buy_sell_ratio NULL above 90% at-offer, source on every row) attach to columns
that table defines, so they land with it.


---

## TMI Engine 01 · steps 1 and 1a

**DDL only.** The specification is explicit that the compute jobs come after the
quote migration, and that nothing populates these until the 6,265 duplicate
quote keys have been resolved.

| | |
|---|---|
| `daily_stock_analysis` | **dropped** — empty, and its 37 columns were the retired Fibonacci and swing strategy |
| `symbol_day` | created, PK `(symbol, trading_date)`, 2 indexes |
| `market_day` | created, PK `trading_date` |

### Column counts differ from the doc's headline

The doc says *90 columns* for `symbol_day` and *20* for `market_day`; the DDL it
contains has **86** and **21**. The DDL was applied as written — inventing four
column names to satisfy a headline is how a column nobody specified ends up in a
table SPREAD depends on. Worth reconciling before the compute job is written.

### Session functions

```sql
SELECT closing_sessions();
-- {Trading,"Close Auction Acceptance","Trading at Last",Close-Of-Day}

SELECT prev_session('2026-08-03');       -- market-wide, 1 session back
SELECT prev_session('2026-08-03', 5);    -- 5 SESSIONS back, for chg_5d
SELECT prev_session_sym('MRC', '2026-08-03');   -- per-symbol
```

`prev_session_sym` is named apart deliberately: two functions of one name
resolve by overload, and a caller passing the wrong shape gets the wrong answer
**silently** — market-wide where it meant per-symbol.

Migration 011 also corrected `closing_sessions()`. My earlier version guessed
`Pre-Open`; the spec says `Close Auction Acceptance`. Pre-open prints are
indications made before the auction crosses and must not count toward a close.

### `daily.analysis` is retired, not deleted

The job returns SKIPPED with an explanation rather than throwing — a job retired
on purpose is not a failure. `dailyCompute.js` is kept: its formulas were hard to
obtain, several outputs survive into `symbol_day` under new names, and the
`symbol_day` job will draw on it.


---

## TMI 01 verification · steps 1 and 1a

Schema diffed column by column against the spec DDL:

```
symbol_day  spec 86, live 86   missing none · extra none · wrong type none
market_day  spec 21, live 21   missing none · extra none · wrong type none
```

PKs, defaults and indexes all as written.

### Two gaps between the RULES and the DDL, now closed

**Rule 5 named a column that did not exist.** *"Set buy_sell_ratio NULL when
pct_at_offer > 90"* — there was no `pct_at_offer`. The rule could be applied but
never audited: a NULL ratio was indistinguishable from *"never computed"*, and
test **S5 (GFH = NULL) passed either way, including with the job broken.**
`pct_at_offer` added, and the rule is now a CHECK — a row breaking it cannot be
written.

**Rule 6 said "source on every row"; the column was nullable.** That asks the
compute job to remember. The failure this rule exists to prevent was itself a
NULL nobody noticed — 11,915 of 14,084 rows returning *"zero active symbols"*.
Now `NOT NULL` with a CHECK on `('AWSAT','TRADINGVIEW')`, which is free while
the table is empty and impossible to add later.

Three documented enums also had no constraint: `data_quality`, `family`,
`regime`. A typo stored silently and every downstream filter missed the row —
the row still existed, so nothing looked wrong.

### The regime rule is a function, and warns only

```sql
SELECT regime_of(18);    -- RISK_OFF   (17 Aug)
SELECT regime_of(52);    -- RISK_ON    (25 Aug)
```

It labels; it gates nothing. Boundaries verified: 34.9 RISK_OFF, 35 NEUTRAL,
50 NEUTRAL, 50.1 RISK_ON, NULL stays NULL.

**25/25** on the enforcement, **51/51** on the DDL.

### Still pending, by design

Rules 3 and 4 — `tiny_pct_up` up-only, and print location over the tick rule —
are compute-job logic with no schema handle, so they land with the job. Test
cases S1–S4, S6–S10 and M1, M3, M5, M6 need real data and the quote migration.


---

## Step 2 · Migrate quotes, deduplicated

```bash
npm run migrate:quotes -- --from=postgresql://user:pass@host/olddb          # dry run
npm run migrate:quotes -- --from=... --apply                                # write
```

**Dry run by default.** Nothing is written without `--apply`.

### The two duplicate classes are not the same problem

```
identical duplicates   collapsed silently — nothing is lost
CONFLICTING            a CHOICE was made — written to tmp/quote-conflicts-*.json
```

Of the 6,265 duplicate keys, 571 have conflicting data. Reporting one number
hides 571 decisions about real observations. The conflicts are listed in full so
they can be read before `--apply`.

**The rule, stated once:** the richest row wins; the last row breaks a tie.
Richness first because a row with a price and no volume is a partial capture,
not a later truth. Last as the tiebreak because the duplicates come from the old
scraper stamping a *rounded* time, so both rows are looks at the same minute and
the later one is more current.

### A pagination bug this surfaced

The reader sorted `ORDER BY created_at, symbol` — the two columns duplicates
share **by definition**. Their relative order is then undefined, and OFFSET
paging over an unstable sort can **skip a row or return it twice**. At 155 test
rows in one batch it cannot show; at 5,000-row batches over the real table it
silently loses data, during the migration whose whole purpose is losing nothing.

Fixed by ending the sort on the primary key, which also makes "the last row"
mean something. Verified: without the tiebreak fewer than 20 of 20 rows survive
paging; with it, all 20 exactly once, repeatably.

Re-running is safe — `ON CONFLICT DO NOTHING`, so a partial run can be resumed.


---

## Order money columns (step 2)

Six columns, all from JSON the broker already sends:

| column | source |
|---|---|
| `avg_price` | `avgPrice` |
| `order_value` | `ordVal` |
| **`net_value`** | **`netOrdVal` — this is the P&L** |
| `status_reason` | the status cell's `title` |
| `executions` | derived; see below |
| `raw` | the whole record |

`net_value` is COALESCEd on update so a later sighting that omits it cannot
erase a value already captured.

### `executions` is derived, not guessed

The grid reports no fill count — but it reports filled quantity, so every time
that **rises** between sightings, one more execution has happened. The
settlement fee is charged per execution: a 6,100-share sell that filled as
5,350 + 750 was charged 2.285 against a formula expecting 1.680.

Verified: 0 → 5,350 → 6,100 gives executions 1 → 2 → 3, and a repeat sighting
does **not** increment. A CHECK prevents it being set below 1, since it
multiplies the fee.

### Two quote columns

`last_trade_time` is now `time`. The cast runs through `NULLIF` first — an empty
string is not a time and would have taken the whole migration down over a blank
cell.

`intrinsic_value` dropped: 100% NULL across 838,762 rows. It was still
referenced in five write paths, all removed — otherwise every insert would have
failed on a column that no longer exists.

### The 10-row ceiling now alarms

The virtualised container is sized to the **full** list even though a screenful
is rendered, so its height ÷ row height is the real total. The capture is
checked against it:

```
scan: 13 row(s) over 9 step(s) · grid says 13
SHORT BY 3                        ← when they differ
```

Ten of thirteen is otherwise indistinguishable from a thirteen-row grid, which
is how five contracts read as three all morning.

**O1–O5: 17/17 and 16/16.** The old scan is asserted to reproduce exactly 10 of
13, and to have alarmed.


---

## Audit before step 3

### A live breakage from the `time` cast

Migration 014 made `last_trade_time` a real `time`, but the scraper still sent
raw cell text. Four of the shapes it produces were **rejected outright**:

```
""                      REJECTED   (whitespace-only cell)
"   "                   REJECTED
"25-08-2026 13:14:10"   REJECTED   (the datetime shape the broker uses elsewhere)
"--"                    REJECTED
```

A rejected row loses its time entirely, so the cast has to happen before the
insert. `parse.toTime()` takes the clock portion wherever it sits and returns
NULL for anything unrecognisable — *"we did not get a time"* is true and
storable; a guess is neither. **12/12**, and all four shapes now store.

### Stale code that would have failed on use

- **`analyseLegacy` still INSERTed into `daily_stock_analysis`**, dropped by
  011. It would have failed with *"relation does not exist"* — reading as a
  broken job rather than a retired one. It now computes and RETURNS the rows,
  which is the part worth keeping for the `symbol_day` job.
- **`validate.js` still nullified `intrinsic_value`**, dropped by 014.
- **`scripts/db-rebase.js`** targeted four tables replaced by 005 and dropped by
  008. It refuses to run and points at `migrate:quotes`. Not deleted — its
  column mapping is the only written account of how the original names lined up.

### Scope

No execution path exists and none was added: no order placement, no cancel, no
broker writes. The userscripts POST only to this server's ingest API, and the
tap listens to the quote socket only — the trading socket is counted, never
read.

### State

11 tables, 3 views, 5 functions from a clean build. All six jobs scheduled,
**zero errors on boot**. 31 suites, 0 failed.


---

## "Which instance is the client posting to?"

Rows accepted by an instance nobody can find are not hypothetical — 140 quotes,
135 depth and 14 orders were accepted and appeared in neither database being
queried, not even in `client_submissions`.

The answer has to come from the process doing the writing. Ask it:

```bash
curl -s localhost:8787/ingest/health
```

```json
{"awsatMode":"client","acceptingClientData":true,"pid":571,
 "db":{"database":"s3c","host":"127.0.0.1/32","port":5432,
       "submissions_24h":0,"quotes_today":0}}
```

`submissions_24h` is the decisive field: if it is non-zero on an instance whose
database you are not querying, that is where the rows went. The same line is
logged at boot as `writing to`.

No credentials are returned — database, host and port identify an instance
without exposing how to reach it.

**If the client's panel shows successful posts and `submissions_24h` is 0 here,
the userscript's `SERVER` points at a different process** — most likely the
deployed `socket.99labs.space` rather than localhost.
