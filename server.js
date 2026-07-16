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

db.initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Gorilla push server listening on ${PORT}`));
    setInterval(runNotificationCheck, CHECK_INTERVAL_MS);
    void runNotificationCheck(); // also run once on boot
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });

