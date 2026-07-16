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
  // --- Operation Feed Alerts: server-side mirror of enabled Feed Watch
  // channels (the client is source of truth; this is just enough for the
  // scheduled check to know what to fetch), plus its own dedup/notify
  // ledger. Server never stores full feed item data (titles are kept
  // only long enough to build a notification and are not the client's
  // record of truth) — the client re-fetches the real item itself when
  // the notification is tapped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_channels (
      id TEXT PRIMARY KEY,
      youtube_channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      notify_enabled BOOLEAN NOT NULL DEFAULT true,
      last_checked_at TIMESTAMPTZ,
      last_successful_check_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_seen_videos (
      youtube_video_id TEXT PRIMARY KEY,
      feed_channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      title TEXT NOT NULL,
      video_url TEXT NOT NULL,
      discovered_at TIMESTAMPTZ DEFAULT now(),
      notification_status TEXT NOT NULL DEFAULT 'pending',
      notified_at TIMESTAMPTZ,
      delivery_result TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_notification_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      global_enabled BOOLEAN NOT NULL DEFAULT true,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      digest_mode BOOLEAN NOT NULL DEFAULT false,
      last_check_at TIMESTAMPTZ,
      last_notification_at TIMESTAMPTZ,
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
  await pool.query(`
    INSERT INTO feed_notification_settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function upsertSubscription(sub) {
  await pool.query(
    `INSERT INTO subscriptions (endpoint, p256dh, auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth`,
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

/* ---------- Feed Alerts: channels ---------- */

/**
 * Replace-set sync, same pattern as syncFollowups: whatever the client
 * currently has enabled is the full truth: rows for channels no longer
 * present in `channels` are removed. Notification settings for a
 * channel that gets removed and later re-added default back to
 * notify-enabled, which is an acceptable, documented simplification —
 * the alternative (retaining settings forever for deleted channels) has
 * its own confusion, and this is a rare path.
 */
async function syncFeedChannels(channels) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = channels.map((c) => c.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');

    if (ids.length > 0) {
      await client.query(`DELETE FROM feed_channels WHERE id NOT IN (${placeholders})`, ids);
      await client.query(`DELETE FROM feed_seen_videos WHERE feed_channel_id NOT IN (${placeholders})`, ids);
    } else {
      await client.query(`DELETE FROM feed_channels`);
      await client.query(`DELETE FROM feed_seen_videos`);
    }

    for (const c of channels) {
      await client.query(
        `INSERT INTO feed_channels (id, youtube_channel_id, name, enabled, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
           youtube_channel_id = EXCLUDED.youtube_channel_id,
           name = EXCLUDED.name,
           enabled = EXCLUDED.enabled,
           updated_at = now()`,
        [c.id, c.youtube_channel_id, c.name, c.enabled]
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

async function listFeedChannels() {
  const { rows } = await pool.query(`SELECT * FROM feed_channels ORDER BY name`);
  return rows;
}

async function setChannelNotifyEnabled(feedChannelId, notifyEnabled) {
  await pool.query(`UPDATE feed_channels SET notify_enabled = $1, updated_at = now() WHERE id = $2`, [
    notifyEnabled,
    feedChannelId,
  ]);
}

async function recordChannelCheckResult(feedChannelId, { success, error }) {
  await pool.query(
    `UPDATE feed_channels
     SET last_checked_at = now(),
         last_successful_check_at = CASE WHEN $1 THEN now() ELSE last_successful_check_at END,
         last_error = $2,
         updated_at = now()
     WHERE id = $3`,
    [success, error ?? null, feedChannelId]
  );
}

/* ---------- Feed Alerts: seen videos / dedup / notification ledger ---------- */

async function hasAnySeenVideos(feedChannelId) {
  const { rows } = await pool.query(`SELECT 1 FROM feed_seen_videos WHERE feed_channel_id = $1 LIMIT 1`, [
    feedChannelId,
  ]);
  return rows.length > 0;
}

async function getSeenVideoIds(feedChannelId) {
  const { rows } = await pool.query(`SELECT youtube_video_id FROM feed_seen_videos WHERE feed_channel_id = $1`, [
    feedChannelId,
  ]);
  return new Set(rows.map((r) => r.youtube_video_id));
}

/** Inserts entries already treated as handled — used for a channel's first server-side check. */
async function insertInitialImport(feedChannelId, channelName, entries) {
  for (const e of entries) {
    await pool.query(
      `INSERT INTO feed_seen_videos
         (youtube_video_id, feed_channel_id, channel_name, title, video_url, notification_status, notified_at)
       VALUES ($1, $2, $3, $4, $5, 'initial_import', now())
       ON CONFLICT (youtube_video_id) DO NOTHING`,
      [e.videoId, feedChannelId, channelName, e.title, e.url]
    );
  }
}

/** Inserts genuinely new entries as pending — eligible for a notification this run or a later one. */
async function insertPendingVideos(feedChannelId, channelName, entries) {
  for (const e of entries) {
    await pool.query(
      `INSERT INTO feed_seen_videos
         (youtube_video_id, feed_channel_id, channel_name, title, video_url, notification_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (youtube_video_id) DO NOTHING`,
      [e.videoId, feedChannelId, channelName, e.title, e.url]
    );
  }
}

async function listActionableVideos() {
  const { rows } = await pool.query(
    `SELECT * FROM feed_seen_videos WHERE notification_status IN ('pending', 'queued_quiet_hours') ORDER BY discovered_at`
  );
  return rows;
}

async function setVideoStatus(youtubeVideoId, status, { notified = false, deliveryResult = null } = {}) {
  await pool.query(
    `UPDATE feed_seen_videos
     SET notification_status = $1, notified_at = CASE WHEN $2 THEN now() ELSE notified_at END, delivery_result = $3
     WHERE youtube_video_id = $4`,
    [status, notified, deliveryResult, youtubeVideoId]
  );
}

/* ---------- Feed Alerts: notification settings ---------- */

async function getFeedNotificationSettings() {
  const { rows } = await pool.query(`SELECT * FROM feed_notification_settings WHERE id = 1`);
  return rows[0];
}

async function updateFeedNotificationSettings(patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = $${i}`);
    values.push(value);
    i += 1;
  }
  if (fields.length === 0) return;
  await pool.query(`UPDATE feed_notification_settings SET ${fields.join(', ')} WHERE id = 1`, values);
}

async function recordGlobalCheck() {
  await pool.query(`UPDATE feed_notification_settings SET last_check_at = now() WHERE id = 1`);
}

async function recordGlobalNotification() {
  await pool.query(`UPDATE feed_notification_settings SET last_notification_at = now() WHERE id = 1`);
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
  syncFeedChannels,
  listFeedChannels,
  setChannelNotifyEnabled,
  recordChannelCheckResult,
  hasAnySeenVideos,
  getSeenVideoIds,
  insertInitialImport,
  insertPendingVideos,
  listActionableVideos,
  setVideoStatus,
  getFeedNotificationSettings,
  updateFeedNotificationSettings,
  recordGlobalCheck,
  recordGlobalNotification,
};

