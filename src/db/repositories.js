'use strict';
/**
 * All database writes live here. The scrapers produce plain objects; this
 * module is the only thing that knows SQL.
 *
 * TWO DECISIONS APPLY THROUGHOUT
 *
 * Multi-row INSERT, not a loop. One statement of 135 rows is one round trip;
 * 135 statements are 135. At one sweep a minute for four hours that is the
 * difference between a scrape that finishes inside its minute and one that
 * does not.
 *
 * ON CONFLICT DO NOTHING against a real UNIQUE constraint. A retry after a
 * partial failure, an overlapping run, or a second process started by mistake
 * all re-offer rows that are already stored. The database rejects them; the
 * application does not have to detect the situation, which it cannot reliably
 * do anyway. `rowCount` then reports how many were genuinely new — the number
 * worth logging, because extracted-but-not-inserted means the feed has stalled.
 */

const { pool, query } = require('./pool');
const log = require('../logger');

/**
 * PostgreSQL allows at most 65535 bind parameters per statement. A batch wider
 * or longer than that fails with a message that does not mention the limit, so
 * the chunk size is computed from the column count rather than guessed.
 */
function chunkSize(columnCount) {
  return Math.max(1, Math.floor(60000 / Math.max(1, columnCount)));
}

/**
 * Build and run a chunked multi-row INSERT.
 *
 * ON A CHUNK FAILURE, FALL BACK TO ROW BY ROW.
 *
 * A multi-row INSERT is one statement, so it is all-or-nothing: a single row
 * that trips a CHECK constraint takes the other 134 down with it. Measured
 * before this fallback existed — a batch of three rows, one with a negative
 * price, stored ZERO. The two valid rows were lost.
 *
 * That is the worst possible failure here, because a trading minute cannot be
 * re-scraped: the source shows now, not five minutes ago. So a failed chunk is
 * retried one row at a time. The good rows land, the bad ones are logged with
 * enough detail to fix the parser, and the run reports how many were rejected.
 *
 * The slow path only runs when something is already wrong, so the cost is paid
 * on the rare bad batch rather than on every good one.
 *
 * @returns {{offered:number, inserted:number, rejected:number}}
 */
async function insertMany(table, columns, rows, conflictTarget) {
  if (!rows.length) return { offered: 0, inserted: 0, rejected: 0 };

  const size = chunkSize(columns.length);
  let inserted = 0;
  let rejected = 0;

  const buildSql = (count) => {
    const tuples = [];
    for (let r = 0; r < count; r += 1) {
      const ph = columns.map((_, c) => `$${r * columns.length + c + 1}`);
      tuples.push(`(${ph.join(', ')})`);
    }
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`
      + (conflictTarget ? ` ON CONFLICT ${conflictTarget} DO NOTHING` : '');
  };

  const valuesOf = (batch) => {
    const v = [];
    for (const row of batch) {
      for (const col of columns) v.push(row[col] === undefined ? null : row[col]);
    }
    return v;
  };

  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    try {
      const res = await query(buildSql(chunk.length), valuesOf(chunk));
      inserted += res.rowCount;
    } catch (err) {
      log.warn('batch insert failed — retrying row by row to save the good rows', {
        table, chunkRows: chunk.length, err: err.message,
      });

      for (const row of chunk) {
        try {
          const res = await query(buildSql(1), valuesOf([row]));
          inserted += res.rowCount;
        } catch (rowErr) {
          rejected += 1;
          // Log the row that failed, not just the count. Without the offending
          // values there is no way to find the parser bug that produced them.
          log.error('row rejected by the database', {
            table,
            reason: rowErr.message,
            row: JSON.stringify(row).slice(0, 400),
          });
        }
      }
    }
  }

  return { offered: rows.length, inserted, rejected };
}

// ─── symbols ────────────────────────────────────────────────────────────────

/**
 * Register every symbol seen in a scrape before the rows that reference it.
 *
 * quotes.symbol and depth_levels.symbol are foreign keys, so an unregistered
 * ticker would fail the whole insert. Upserting here means a newly listed stock
 * is picked up automatically instead of needing a manual step, and last_seen_on
 * keeps moving so a delisting becomes visible as a symbol that stopped updating.
 */
async function upsertSymbols(symbols) {
  const rows = symbols
    .filter((s) => s && s.symbol && String(s.symbol).trim())
    .map((s) => ({
      market: (s.market || 'UNKNOWN').trim(),
      symbol: String(s.symbol).trim().toUpperCase(),
      code: s.code || null,
      description: s.description || s.name || null,
    }));
  if (!rows.length) return { offered: 0, inserted: 0, rejected: 0, symbols: [] };

  // Deduplicate within the batch: two rows with the same key in one statement
  // raise "ON CONFLICT DO UPDATE cannot affect row a second time", which
  // ON CONFLICT itself cannot rescue.
  //
  // The key is the SYMBOL since migration 026. Keying on market+symbol here
  // while the table keys on symbol alone lets both rows of a market change
  // reach one statement, which raises that very error — the dedupe has to
  // agree with the constraint it exists to protect.
  //
  // The LAST occurrence wins, so a batch that carries a symbol's old and new
  // market keeps the newer one.
  const unique = [...new Map(rows.map((r) => [r.symbol, r])).values()];

  const values = [];
  const tuples = unique.map((r, i) => {
    values.push(r.market, r.symbol, r.code, r.description);
    return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
  });

  const res = await query(
    `INSERT INTO instruments (market, symbol, code, description)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (symbol) DO UPDATE SET
         market = EXCLUDED.market,
       code         = COALESCE(EXCLUDED.code, instruments.code),
       description  = COALESCE(EXCLUDED.description, instruments.description),
       last_seen_on = CURRENT_DATE,
       is_active    = true,
       updated_at   = now()
     RETURNING symbol`,
    values,
  );
  return {
    offered: unique.length,
    inserted: res.rowCount,
    rejected: 0,
    symbols: res.rows.map((r) => r.symbol),
  };
}

// ─── scrape_runs ────────────────────────────────────────────────────────────

/**
 * A run that is already over — for work that arrives rather than being started.
 *
 * ─── WHY THE INGEST API NEEDS THIS ─────────────────────────────────────────
 * Quotes, depth and orders arrive by POST from the userscripts, not from a
 * scheduled job. With AWSAT_MODE=client the awsat.* jobs are SKIPPED, so the
 * three feeds the strategy actually depends on were the ONLY ones absent from
 * the table built to answer "did it run".
 *
 * client_submissions records the same POSTs, but holding one fact in two
 * shapes means "check the scrapers" is two queries — and the one people run is
 * the one that misses the broker.
 *
 * startRun/finishRun assume a beginning and an end around work in progress. A
 * POST is complete by the time it can be logged, so this writes the row whole.
 */
async function recordRun(scraper, tradingDay, {
  status = 'SUCCESS', rowsExtracted = 0, rowsInserted = 0, durationMs = null, error = null,
} = {}) {
  const { rows } = await query(
    `INSERT INTO scrape_runs
       (scraper, trading_date, status, finished_at, duration_ms,
        rows_extracted, rows_inserted, error_message)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7) RETURNING id`,
    [scraper, tradingDay, status, durationMs, rowsExtracted, rowsInserted,
      error ? String(error.message || error).slice(0, 1000) : null],
  );
  return rows[0].id;
}

async function startRun(scraper, tradingDay) {
  const { rows } = await query(
    `INSERT INTO scrape_runs (scraper, trading_date, status)
     VALUES ($1, $2, 'RUNNING') RETURNING id`,
    [scraper, tradingDay],
  );
  return rows[0].id;
}

async function finishRun(runId, { status, rowsExtracted = 0, rowsInserted = 0, error = null, startedAt }) {
  await query(
    `UPDATE scrape_runs
        SET status = $2, finished_at = now(),
            duration_ms = $3, rows_extracted = $4, rows_inserted = $5,
            error_message = $6, error_stack = $7
      WHERE id = $1`,
    [
      runId,
      status,
      startedAt ? Date.now() - startedAt : null,
      rowsExtracted,
      rowsInserted,
      error ? String(error.message).slice(0, 1000) : null,
      error ? String(error.stack || '').slice(0, 4000) : null,
    ],
  );
}

// ─── quotes ─────────────────────────────────────────────────────────────────

/** Matches the awsat_market_quotes column list. */
/** TradingView watchlist columns. */
const TV_WATCHLIST_COLUMNS = [
  'symbol', 'company_name', 'last_price', 'change_value', 'change_pct',
  'volume', 'avg_volume', 'market_cap', 'trading_date', 'scrape_batch_id',
  'run_id', 'created_at',
];

/** AWSAT board columns. ingest_source is part of the key, not a label. */
const AWSAT_QUOTE_COLUMNS = [
  'scrape_batch_id', 'market', 'symbol', 'code', 'description',
  'last_price', 'last_qty', 'chg', 'pct_chg', 'volume',
  'bid', 'bid_qty', 'offer', 'offer_qty', 'trades',
  'last_trade_date', 'last_trade_time',
  // intrinsic_value was dropped by 014: 100% NULL across 838,762 rows. The
  // feed does not send it, and keeping the column invited reading the NULL as
  // zero rather than "never provided".
  'open_price', 'high_price', 'low_price', 'session', 'nms',
  'trading_date', 'ingest_source', 'source_precedence', 'run_id', 'created_at',
];

const PRECEDENCE = { awsat_client: 2, awsat_server: 1, tradingview: 0 };

/**
 * Route a quote batch to its own table.
 *
 * TradingView and AWSAT are different feeds with different columns and
 * different cadences; a shared table meant every query had to remember to
 * filter by source, and forgetting was silent.
 */
async function insertQuotes(quotes) {
  if (!quotes.length) return { offered: 0, inserted: 0, rejected: 0 };

  const tv = [];
  const aw = [];
  for (const q of quotes) {
    if (q.source === 'tradingview' || q.ingest_source === 'tradingview') tv.push(q);
    else aw.push(q);
  }

  let inserted = 0;
  let rejected = 0;
  let offered = 0;

  if (tv.length) {
    const seen = new Set();
    const rows = [];
    for (const q of tv) {
      const key = `${q.symbol}|${q.created_at && q.created_at.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        symbol: q.symbol,
        company_name: q.description ?? q.company_name ?? null,
        last_price: q.last_price ?? null,
        change_value: q.chg ?? q.change_value ?? null,
        change_pct: q.pct_chg ?? q.change_pct ?? null,
        volume: q.volume ?? null,
        avg_volume: q.avg_volume ?? null,
        market_cap: q.market_cap ?? null,
        trading_date: q.trading_date,
        scrape_batch_id: q.scrape_batch_id ?? null,
        run_id: q.run_id ?? null,
        created_at: q.created_at,
      });
    }
    const r = await insertMany('tradingview_watchlist', TV_WATCHLIST_COLUMNS, rows,
      '(symbol, created_at)');
    inserted += r.inserted; rejected += r.rejected; offered += r.offered;
  }

  if (aw.length) {
    const seen = new Set();
    const rows = [];
    for (const q of aw) {
      const src = q.ingest_source && PRECEDENCE[q.ingest_source]
        ? q.ingest_source : 'awsat_server';
      const key = `${q.market}|${q.symbol}|${q.created_at && q.created_at.toISOString()}|${src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...q,
        ingest_source: src,
        source_precedence: q.source_precedence ?? PRECEDENCE[src] ?? 1,
      });
    }
    const r = await insertMany('awsat_market_quotes', AWSAT_QUOTE_COLUMNS, rows,
      '(market, symbol, created_at, ingest_source)');
    inserted += r.inserted; rejected += r.rejected; offered += r.offered;
  }

  return { offered, inserted, rejected };
}

// ─── depth ──────────────────────────────────────────────────────────────────

const DEPTH_COLUMNS = [
  'symbol', 'level', 'bid', 'bid_qty', 'bid_orders',
  'offer', 'offer_qty', 'offer_orders', 'code', 'trading_date', 'ingest_source',
  'run_id', 'created_at', 'captured_at',
];

/**
 * Depth levels, keyed on the SNAPSHOT.
 *
 * captured_at is when the book was read; created_at is when the row was
 * written. Ten levels of one book share the former, and that is what groups a
 * snapshot — grouping on created_at works only while ten inserts land in the
 * same millisecond.
 *
 * captured_at defaults to created_at when the client does not send it, because
 * the column is NOT NULL and a missing capture time is still better recorded
 * as the insert time than as a rejected row.
 */
async function insertDepth(levels) {
  const rows = levels.map((d) => {
    const at = d.created_at || new Date();
    return {
      ...d,
      ingest_source: d.ingest_source || 'awsat_server',
      created_at: at,
      captured_at: d.captured_at || at,
    };
  });
  return insertMany('awsat_stock_depth', DEPTH_COLUMNS, rows,
    '(symbol, level, captured_at, ingest_source)');
}

// ─── orders ─────────────────────────────────────────────────────────────────

const ORDER_COLUMNS = [
  'order_id', 'symbol', 'side', 'order_status', 'price', 'quantity',
  'filled_quantity', 'remaining_qty', 'order_time', 'trading_date',
  'ingest_source', 'run_id', 'created_at', 'first_seen_at', 'last_seen_at',
  // Added by 014. net_value is the P&L number.
  'avg_price', 'order_value', 'net_value', 'status_reason', 'raw',
  // 020. The live path must fill what the migration fills.
  'code', 'order_type', 'exchange', 'portfolio',
];

/**
 * UPSERT on order_id: one row per order, however often it is seen.
 *
 * Not insertMany — that is ON CONFLICT DO NOTHING, which would keep the FIRST
 * sighting for ever and never learn that an order filled. An order's status is
 * the whole point of watching it, so a later sighting must win.
 *
 * created_at and first_seen_at are preserved from the original row; everything
 * that can change is taken from the new sighting.
 */
async function insertOrders(orders) {
  if (!orders.length) return { offered: 0, inserted: 0, rejected: 0 };

  // Within one batch the same order should appear once. The terminal can render
  // it twice mid-scroll, and ON CONFLICT cannot resolve a duplicate that arrives
  // inside a single statement.
  const seen = new Set();
  const rows = [];
  for (const o of orders) {
    if (!o.order_id || seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    const at = o.created_at || new Date();
    rows.push({
      ...o,
      ingest_source: o.ingest_source || 'awsat_server',
      created_at: at,
      first_seen_at: at,
      last_seen_at: at,
    });
  }
  if (!rows.length) return { offered: orders.length, inserted: 0, rejected: 0 };

  const cols = ORDER_COLUMNS.join(', ');
  const values = [];
  const tuples = rows.map((row, r) => {
    const ph = ORDER_COLUMNS.map((c, i) => {
      values.push(row[c] === undefined ? null : row[c]);
      return `$${r * ORDER_COLUMNS.length + i + 1}`;
    });
    return `(${ph.join(', ')})`;
  });

  try {
    const res = await query(
      `INSERT INTO awsat_order_list (${cols}) VALUES ${tuples.join(', ')}
       ON CONFLICT (order_id) DO UPDATE SET
         symbol          = COALESCE(EXCLUDED.symbol, awsat_order_list.symbol),
         side            = COALESCE(EXCLUDED.side, awsat_order_list.side),
         order_status    = EXCLUDED.order_status,
         price           = EXCLUDED.price,
         quantity        = EXCLUDED.quantity,
         filled_quantity = EXCLUDED.filled_quantity,
         remaining_qty   = EXCLUDED.remaining_qty,
         order_time      = COALESCE(EXCLUDED.order_time, awsat_order_list.order_time),
         ingest_source   = EXCLUDED.ingest_source,
         run_id          = EXCLUDED.run_id,
         avg_price       = COALESCE(EXCLUDED.avg_price, awsat_order_list.avg_price),
         order_value     = COALESCE(EXCLUDED.order_value, awsat_order_list.order_value),
         -- net_value is the P&L. COALESCE so a later sighting that omits it
         -- cannot erase a value already captured.
         net_value       = COALESCE(EXCLUDED.net_value, awsat_order_list.net_value),
         status_reason   = COALESCE(EXCLUDED.status_reason, awsat_order_list.status_reason),
         code            = COALESCE(EXCLUDED.code, awsat_order_list.code),
         order_type      = COALESCE(EXCLUDED.order_type, awsat_order_list.order_type),
         exchange        = COALESCE(EXCLUDED.exchange, awsat_order_list.exchange),
         portfolio       = COALESCE(EXCLUDED.portfolio, awsat_order_list.portfolio),
         raw             = COALESCE(EXCLUDED.raw, awsat_order_list.raw),
         -- EXECUTIONS, derived from what we actually observe.
         --
         -- The order grid does not report a fill count, but it does report the
         -- filled quantity — so every time that RISES between sightings, one
         -- more execution has happened. The settlement fee is per execution,
         -- so this number is the difference between 1.680 and 2.285 on a
         -- 6,100-share sell that filled as 5,350 + 750.
         executions_observed = CASE
           WHEN EXCLUDED.filled_quantity IS NOT NULL
            AND awsat_order_list.filled_quantity IS NOT NULL
            AND EXCLUDED.filled_quantity > awsat_order_list.filled_quantity
           THEN COALESCE(awsat_order_list.executions_observed, 1) + 1
           ELSE COALESCE(awsat_order_list.executions_observed, 1)
         END,
         -- first_seen_at and created_at keep the ORIGINAL sighting.
         last_seen_at    = EXCLUDED.last_seen_at,
         sighting_count  = awsat_order_list.sighting_count + 1,
         updated_at      = now()
       RETURNING order_id`,
      values,
    );
    return { offered: orders.length, inserted: res.rowCount, rejected: 0 };
  } catch (err) {
    // Same reasoning as insertMany: one bad order must not lose the rest.
    log.warn('order batch failed — retrying row by row', { rows: rows.length, err: err.message });
    let inserted = 0;
    let rejected = 0;
    for (const row of rows) {
      try {
        const one = await query(
          `INSERT INTO awsat_order_list (${cols})
           VALUES (${ORDER_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (order_id) DO UPDATE SET
             order_status = EXCLUDED.order_status,
             filled_quantity = EXCLUDED.filled_quantity,
             remaining_qty = EXCLUDED.remaining_qty,
             last_seen_at = EXCLUDED.last_seen_at,
             sighting_count = awsat_order_list.sighting_count + 1,
             updated_at = now()`,
          ORDER_COLUMNS.map((c) => (row[c] === undefined ? null : row[c])),
        );
        inserted += one.rowCount;
      } catch (rowErr) {
        rejected += 1;
        log.error('order rejected by the database', {
          reason: rowErr.message, row: JSON.stringify(row).slice(0, 300),
        });
      }
    }
    return { offered: orders.length, inserted, rejected };
  }
}

// ─── daily history ──────────────────────────────────────────────────────────

/**
 * tradingview_history columns.
 *
 * No `source`: this table holds TradingView history only, so a source column
 * would carry the same value on every row and imply a choice that does not
 * exist. AWSAT history, if it ever arrives, belongs in its own table with its
 * own shape rather than sharing this one behind a discriminator.
 */
const DAILY_COLUMNS = [
  'symbol', 'trade_date', 'open_price', 'high_price', 'low_price', 'close_price',
  'change_value', 'change_pct', 'volume', 'run_id',
];

/**
 * UPSERT, unlike quotes which are insert-only.
 *
 * An exchange can restate a daily bar after the fact — a late print, a
 * correction — so a re-scrape must be allowed to overwrite. Quotes are live
 * ticks and are never revised; letting a history pass rewrite them would be a
 * correction overwriting an observation.
 */
async function upsertDailyPrices(rows) {
  if (!rows.length) return { offered: 0, inserted: 0, rejected: 0 };

  // Same day twice in one statement raises "cannot affect row a second time",
  // which ON CONFLICT cannot rescue.
  const unique = [...new Map(rows.map((r) => [`${r.symbol}|${r.trade_date}`, r])).values()];

  const cols = DAILY_COLUMNS.join(', ');
  const values = [];
  const tuples = unique.map((row, r) => {
    const ph = DAILY_COLUMNS.map((c, i) => {
      values.push(row[c] === undefined ? null : row[c]);
      return `$${r * DAILY_COLUMNS.length + i + 1}`;
    });
    return `(${ph.join(', ')})`;
  });

  try {
    const res = await query(
      `INSERT INTO tradingview_history (${cols}) VALUES ${tuples.join(', ')}
       ON CONFLICT (symbol, trade_date) DO UPDATE SET
         open_price = EXCLUDED.open_price, high_price = EXCLUDED.high_price,
         low_price = EXCLUDED.low_price,   close_price = EXCLUDED.close_price,
         change_value = EXCLUDED.change_value,
         change_pct = EXCLUDED.change_pct,
         volume = EXCLUDED.volume, run_id = EXCLUDED.run_id,
         session_finalised_at = now(), updated_at = now()`,
      values,
    );
    return { offered: unique.length, inserted: res.rowCount, rejected: 0 };
  } catch (err) {
    // Same reasoning as insertMany: one bad bar must not lose the rest.
    log.warn('daily batch failed — retrying row by row', { rows: unique.length, err: err.message });
    let inserted = 0; let rejected = 0;
    for (const row of unique) {
      try {
        const one = await query(
          `INSERT INTO tradingview_history (${cols})
           VALUES (${DAILY_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (symbol, trade_date) DO UPDATE SET
             open_price = EXCLUDED.open_price, high_price = EXCLUDED.high_price,
             low_price = EXCLUDED.low_price,   close_price = EXCLUDED.close_price,
             change_value = EXCLUDED.change_value,
             change_pct = EXCLUDED.change_pct,
             volume = EXCLUDED.volume, run_id = EXCLUDED.run_id,
         session_finalised_at = now(), updated_at = now()`,
          DAILY_COLUMNS.map((c) => (row[c] === undefined ? null : row[c])),
        );
        inserted += one.rowCount;
      } catch (rowErr) {
        rejected += 1;
        log.error('daily row rejected', {
          reason: rowErr.message, row: JSON.stringify(row).slice(0, 300),
        });
      }
    }
    return { offered: unique.length, inserted, rejected };
  }
}

/** Symbols the live scraper has seen, newest activity first. */
async function activeSymbols(limit = 500) {
  const { rows } = await query(
    `SELECT DISTINCT ON (symbol) symbol FROM instruments
      WHERE is_active = true ORDER BY symbol, last_seen_on DESC LIMIT $1`, [limit],
  );
  return rows.map((r) => r.symbol);
}

// ─── reporting ──────────────────────────────────────────────────────────────

/** Last run per scraper — used by `npm run migrate:status` and on startup. */
async function recentRuns(limit = 10) {
  const { rows } = await query(
    `SELECT DISTINCT ON (scraper)
            scraper, status, started_at, duration_ms, rows_extracted, rows_inserted, error_message
       FROM scrape_runs
      ORDER BY scraper, started_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

module.exports = {
  pool,
  upsertSymbols,
  startRun,
  finishRun,
  recordRun,
  insertQuotes,
  insertDepth,
  insertOrders,
  upsertDailyPrices,
  activeSymbols,
  recentRuns,
  log,
};
