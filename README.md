# PROJECT GORILLA — PUSH SERVER

Sends push notifications for due/overdue follow-ups. Deployed on Railway.
This is a real backend — the only piece of Project Gorilla that isn't
local-first — and it holds nothing except push subscriptions and a
synced copy of follow-up descriptions/due-dates/contact-names. Nothing
else about your data ever reaches it.

## What it does

- Holds one row per device that's enabled notifications
- Holds a synced copy of your currently-open follow-ups (id, description,
  due_date, contact_name — nothing else)
- Every 5 minutes, checks for follow-ups that just became due and
  haven't been notified yet, and pushes to every subscribed device
- That's it. No dashboard, no auth, no other data.

## Deploy to Railway

1. **Create a new Railway project**, deploy from this folder (or push it
   to its own GitHub repo and connect that — either works).
2. **Add a Postgres database** to the project — Railway's "+ New" →
   Database → PostgreSQL. This automatically sets `DATABASE_URL` as an
   environment variable on your service; you don't need to configure
   anything else for it.
3. **Generate a VAPID keypair** (one-time, from any machine with Node):
   ```
   npx web-push generate-vapid-keys
   ```
4. **Set environment variables** on the Railway service (Settings →
   Variables):
   - `VAPID_PUBLIC_KEY` — from step 3
   - `VAPID_PRIVATE_KEY` — from step 3 (keep this one secret — never put
     it in client code or commit it)
   - `VAPID_SUBJECT` — `mailto:you@example.com` (any contact email;
     required by the Web Push spec, not used for anything else)
5. **Deploy.** Railway auto-detects the Node app from `package.json` and
   runs `npm start`. Once it's live, copy the public URL Railway gives
   you (looks like `https://your-app.up.railway.app`).
6. **In Project Gorilla**, open Settings → Notifications, paste that URL,
   tap "Save & check connection" to confirm it's reachable, then tap
   "Enable notifications."

## Local development

```
npm install
cp .env.example .env    # fill in DATABASE_URL (a local Postgres) and VAPID keys
npm start
```

## Endpoints

- `GET /health` — used by the app to confirm the server's reachable
- `GET /vapid-public-key` — the app fetches this when subscribing
- `POST /subscribe` — stores a device's push subscription
- `POST /sync-followups` — replaces the tracked follow-up set with
  whatever the app currently has open

## Honest limitations

- **Check interval is 5 minutes**, not instant — a follow-up due at
  2:00pm might not push until 2:05pm.
- **No per-device targeting.** Every subscribed device gets every
  notification. Fine for one person on one or two devices; would need
  real design work to support multiple people.
- **Tested against an in-memory Postgres-compatible engine (`pg-mem`),
  not real Postgres**, since a live database wasn't available in the
  build environment. The core sync logic (particularly the tricky part —
  correctly resetting notification state after a snooze, without
  spamming a repeat notification on every routine sync) was verified
  directly and a real bug was caught and fixed during that testing. But
  end-to-end delivery through Railway's actual Postgres and the real Web
  Push network was not verified — that needs a live deploy to confirm.
