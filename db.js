/**
 * PROJECT GORILLA PUSH SERVER — database
 * Two tables: push subscriptions (one per device that's enabled
 * notifications) and synced_followups (only description, due_date, and
 * contact_name — deliberately not the rest of the app's data model).
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS synced_followups (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      due_date TIMESTAMPTZ NOT NULL,
      contact_name TEXT,
      notified_at TIMESTAMPTZ
    );
  `);
}

async function upsertSubscription(sub) {
  await pool.query(
    `INSERT INTO subscriptions (endpoint, p256dh, auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO NOTHING`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
}

async function removeSubscriptionByEndpoint(endpoint) {
  await pool.query(`DELETE FROM subscriptions WHERE endpoint = $1`, [endpoint]);
}

async function listSubscriptions() {
  const { rows } = await pool.query(`SELECT * FROM subscriptions`);
  return rows;
}

/**
 * Replaces the synced set with exactly what the client currently has
 * open — anything not in `followups` gets deleted, so completed or
 * dropped follow-ups stop being tracked automatically.
 *
 * The "should this reset notified_at" decision is computed here in JS
 * against a pre-fetched snapshot of current rows, rather than as a
 * same-statement self-referential SQL comparison inside ON CONFLICT DO
 * UPDATE — that pattern's evaluation order is a genuine edge case, and
 * it's worth being explicit and testable rather than clever.
 */
async function syncFollowups(followups) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ids = followups.map((f) => f.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');

    if (ids.length > 0) {
      await client.query(`DELETE FROM synced_followups WHERE id NOT IN (${placeholders})`, ids);
    } else {
      await client.query(`DELETE FROM synced_followups`);
    }

    const existing =
      ids.length > 0
        ? await client.query(
            `SELECT id, due_date, notified_at FROM synced_followups WHERE id IN (${placeholders})`,
            ids
          )
        : { rows: [] };
    const existingById = new Map(existing.rows.map((r) => [r.id, r]));

    for (const f of followups) {
      const prior = existingById.get(f.id);
      const dueDateChanged = !prior || new Date(prior.due_date).getTime() !== new Date(f.due_date).getTime();
      const notifiedAt = dueDateChanged ? null : prior.notified_at;

      await client.query(
        `INSERT INTO synced_followups (id, description, due_date, contact_name, notified_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           description = EXCLUDED.description,
           contact_name = EXCLUDED.contact_name,
           due_date = EXCLUDED.due_date,
           notified_at = EXCLUDED.notified_at`,
        [f.id, f.description, f.due_date, f.contact_name ?? null, notifiedAt]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listUnnotifiedFollowups() {
  const { rows } = await pool.query(`SELECT * FROM synced_followups WHERE notified_at IS NULL`);
  return rows;
}

async function markNotified(id) {
  await pool.query(`UPDATE synced_followups SET notified_at = now() WHERE id = $1`, [id]);
}

module.exports = {
  pool,
  initSchema,
  upsertSubscription,
  removeSubscriptionByEndpoint,
  listSubscriptions,
  syncFollowups,
  listUnnotifiedFollowups,
  markNotified,
};
