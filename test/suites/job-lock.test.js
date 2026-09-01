// TWO PROCESSES, which is the case the lock exists for.
//
// The in-process `running` Set catches an overlap inside ONE process and knows
// nothing about another. Testing from a single process only ever exercises the
// Set — which is why this spawns a child.
const { fork } = require('child_process');
const path = require('path');

if (process.env.LOCK_CHILD) {
  const jobs = require('../../src/jobs');
  const { pool } = require('../../src/db/pool');
  (async () => {
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return { extracted: 1, inserted: 1, rejected: 0 };
    };
    const r = await jobs._runJob('test.lock', slow, {});
    process.send({ status: r.status, reason: r.reason || null });
    await pool.end();
    process.exit(0);
  })();
} else {
  const { pool } = require('../../src/db/pool');
  const results = [];
  let done = 0;
  for (let i = 0; i < 2; i += 1) {
    const c = fork(__filename, [], { env: { ...process.env, LOCK_CHILD: '1' }, silent: true });
    c.on('message', (m) => results.push(m));
    c.on('exit', async () => {
      done += 1;
      if (done < 2) return;
      const ok = results.filter((r) => r.status === 'SUCCESS').length;
      const skipped = results.filter((r) => r.status === 'SKIPPED').length;
      console.log('  results:', JSON.stringify(results));
      console.log(`  ${ok} ran · ${skipped} skipped  (expect 1 and 1)`);
      const { rows } = await pool.query(
        "select status, error_message from scrape_runs where scraper='test.lock' order by id");
      for (const r of rows) console.log('   scrape_runs:', r.status, '·', r.error_message || '(none)');
      await pool.query("delete from scrape_runs where scraper='test.lock'");
      await pool.end();
      console.log(`\njob lock: ${ok === 1 && skipped === 1 ? '2/2' : '0/2'}`);
      process.exit(ok === 1 && skipped === 1 ? 0 : 1);
    });
  }
}
