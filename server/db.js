const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000
});

async function query(text, params = []) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.SQL_DEBUG === 'true') {
      console.log('[sql]', { ms: Date.now() - started, rows: result.rowCount, text });
    }
    return result;
  } catch (error) {
    console.error('[sql:error]', { text, params, error: error.message });
    throw error;
  }
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
