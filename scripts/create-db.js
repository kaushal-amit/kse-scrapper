'use strict';
/**
 * Create the database named in DATABASE_URL, if it does not already exist.
 *
 * A migration cannot do this: CREATE DATABASE is not allowed inside a
 * transaction, and connecting to a database in order to create that same
 * database is circular. So this connects to the maintenance `postgres` database
 * and creates the target from there.
 *
 * Safe to re-run: it checks first and reports rather than failing.
 */

const { Client } = require('pg');
const { config } = require('../src/config');

async function main() {
  const url = new URL(config.db.url);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName) throw new Error('DATABASE_URL has no database name in its path');

  url.pathname = '/postgres';
  const client = new Client({
    connectionString: url.toString(),
    ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : false,
  });

  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length) {
      console.log(`database "${dbName}" already exists`);
      return;
    }
    // Identifiers cannot be bound as parameters, so the name is quoted instead.
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`database "${dbName}" created`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\nCould not create the database: ${err.message}`);
  console.error('This needs a role with CREATE DATABASE privilege.\n');
  process.exit(1);
});
