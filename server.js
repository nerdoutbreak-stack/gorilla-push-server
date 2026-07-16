/**
 * PROJECT GORILLA PUSH SERVER
 * Deployed on Railway. Holds push subscriptions and a minimal synced
 * slice of follow-up due dates — nothing else about the app's data ever
 * reaches this server. See README.md for setup.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const db = require('./db');
const { selectDueForNotification, buildNotificationPayload, shouldMarkNotified } = require('./lib/notifyLogic');
const { runFeedAlertsCheck, sendTestAlert } = require('./feedAlerts');
const { fetchChannelFeed } = require('./lib/youtubeFeedFetch');

const FEED_ALERTS_CHECK_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes — Railway has no real cron, just this timer
const TEST_ALERT_MIN_INTERVAL_MS = 60 * 1000; // rate-limit the manual test button to once per minute
let lastTestAlertAt = 0;

const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars. Notifications cannot be sent.');
} else {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/vapid-public-key', (_req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Server not configured.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/subscribe', async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Malformed subscription.' });
  }
  try {
    await db.upsertSubscription(sub);
    res.json({ ok: true });
  } catch (err) {
    console.error('subscribe error', err);
    res.status(500).json({ error: 'Could not save subscription.' });
  }
});

/**
 * Safe, targeted removal — deletes only the one matching endpoint, never
 * a bulk wipe. Used by the client's reset flow before creating a fresh
 * subscription, so a stale endpoint from an old VAPID keypair (or a
 * reinstalled PWA) doesn't linger in the table. Best-effort from the
 * client's point of view: a missing/unknown endpoint is not an error.
 */
app.post('/unsubscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'endpoint is required.' });
  }
  try {
    await db.removeSubscriptionByEndpoint(endpoint);
    res.json({ ok: true });
  } catch (err) {
    console.error('unsubscribe error', err);
    res.status(500).json({ error: 'Could not remove subscription.' });
  }
});

app.post('/sync-followups', async (req, res) => {
  const followups = Array.isArray(req.body?.followups) ? req.body.followups : null;
  if (!followups) return res.status(400).json({ error: 'followups array required.' });

  const valid = followups.filter((f) => f && f.id && f.description && f.due_date);
  try {
    await db.syncFollowups(valid);
    res.json({ ok: true, synced: valid.length });
  } catch (err) {
    console.error('sync error', err);
    res.status(500).json({ error: 'Could not sync follow-ups.' });
  }
});

/* ---------- Feed Alerts ---------- */

/** Replace-set sync of enabled Feed Watch channels, same shape as /sync-followups. */
app.post('/sync-feed-channels', async (req, res) => {
  const channels = Array.isArray(req.body?.channels) ? req.body.channels : null;
  if (!channels) return res.status(400).json({ error: 'channels array required.' });

  const valid = channels.filter((c) => c && c.id && c.youtube_channel_id && c.name);
  try {
    await db.syncFeedChannels(valid);
    res.json({ ok: true, synced: valid.length });
  } catch (err) {
    console.error('feed channel sync error', err);
    res.status(500).json({ error: 'Could not sync channels.' });
  }
});

app.get('/feed-notification-settings', async (_req, res) => {
  try {
    const settings = await db.getFeedNotificationSettings();
    const channels = await db.listFeedChannels();
    res.json({
      settings,
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        notify_enabled: c.notify_enabled,
        last_checked_at: c.last_checked_at,
        last_successful_check_at: c.last_successful_check_at,
        last_error: c.last_error,
      })),
    });
  } catch (err) {
    console.error('feed settings fetch error', err);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

const ALLOWED_SETTINGS_FIELDS = ['global_enabled', 'quiet_hours_start', 'quiet_hours_end', 'timezone', 'digest_mode'];

app.post('/feed-notification-settings', async (req, res) => {
  const patch = {};
  for (const key of ALLOWED_SETTINGS_FIELDS) {
    if (key in (req.body || {})) patch[key] = req.body[key];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No recognized settings fields in request.' });
  }
  try {
    await db.updateFeedNotificationSettings(patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('feed settings update error', err);
    res.status(500).json({ error: 'Could not update settings.' });
  }
});

app.post('/feed-notification-settings/channel', async (req, res) => {
  const { feed_channel_id, notify_enabled } = req.body || {};
  if (!feed_channel_id || typeof notify_enabled !== 'boolean') {
    return res.status(400).json({ error: 'feed_channel_id and notify_enabled (boolean) are required.' });
  }
  try {
    await db.setChannelNotifyEnabled(feed_channel_id, notify_enabled);
    res.json({ ok: true });
  } catch (err) {
    console.error('channel notify setting error', err);
    res.status(500).json({ error: 'Could not update that channel.' });
  }
});

app.get('/feed-alerts-status', async (_req, res) => {
  try {
    const settings = await db.getFeedNotificationSettings();
    res.json({
      lastCheckAt: settings.last_check_at,
      lastNotificationAt: settings.last_notification_at,
    });
  } catch (err) {
    console.error('feed alerts status error', err);
    res.status(500).json({ error: 'Could not load status.' });
  }
});

/** Rate-limited manual test — bypasses quiet hours/dedup, sends immediately to every subscription. */
app.post('/test-feed-alert', async (_req, res) => {
  const now = Date.now();
  if (now - lastTestAlertAt < TEST_ALERT_MIN_INTERVAL_MS) {
    return res.status(429).json({ error: 'Please wait a moment before testing again.' });
  }
  lastTestAlertAt = now;
  try {
    const result = await sendTestAlert(db, webpush);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('test feed alert error', err);
    res.status(500).json({ error: 'Could not send a test alert.' });
  }
});

/** Checks for newly-due follow-ups and pushes to every stored subscription. */
async function runNotificationCheck() {
  try {
    const [unnotified, subscriptions] = await Promise.all([
      db.listUnnotifiedFollowups(),
      db.listSubscriptions(),
    ]);
    const due = selectDueForNotification(unnotified, new Date());
    if (due.length === 0) return;

    for (const followup of due) {
      const payload = JSON.stringify(buildNotificationPayload(followup));
      let anyDelivered = false;

      for (const sub of subscriptions) {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };
        try {
          await webpush.sendNotification(pushSubscription, payload);
          anyDelivered = true;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await db.removeSubscriptionByEndpoint(sub.endpoint);
          } else {
            console.error('push send error', err.statusCode, err.body || err.message);
          }
        }
      }

      if (shouldMarkNotified(subscriptions.length, anyDelivered)) {
        await db.markNotified(followup.id);
      }
    }
  } catch (err) {
    console.error('notification check failed', err);
  }
}

/** Wraps runFeedAlertsCheck with the real db/webpush/fetch, and never throws past this boundary. */
async function runFeedAlertsCheckSafe() {
  try {
    await runFeedAlertsCheck({ db, webpush, fetchChannelFeed });
  } catch (err) {
    console.error('feed alerts check failed', err);
  }
}

db.initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Gorilla push server listening on ${PORT}`));
    setInterval(runNotificationCheck, CHECK_INTERVAL_MS);
    setInterval(runFeedAlertsCheckSafe, FEED_ALERTS_CHECK_INTERVAL_MS);
    void runNotificationCheck(); // also run once on boot
    void runFeedAlertsCheckSafe();
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });

