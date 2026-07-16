/**
 * PROJECT GORILLA PUSH SERVER — Feed Alerts orchestration
 * Ties together the server's own copy of enabled Feed Watch channels,
 * a YouTube RSS fetch, dedup/notification bookkeeping in Postgres, and
 * web-push delivery. Deliberately takes its dependencies (db, webpush,
 * fetchChannelFeed) as arguments rather than requiring them directly,
 * so this whole flow can be exercised in tests with fakes — no real
 * Postgres or push service required to verify the decision logic.
 */
const { isWithinQuietHours, buildVideoNotificationPayload, buildDigestPayload } = require('./lib/feedAlertsLogic');
const { shouldMarkNotified } = require('./lib/notifyLogic');

async function sendToAllSubscriptions(webpush, db, subscriptions, payload) {
  let anyDelivered = false;
  const json = JSON.stringify(payload);
  for (const sub of subscriptions) {
    const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(pushSubscription, json);
      anyDelivered = true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.removeSubscriptionByEndpoint(sub.endpoint);
      } else {
        console.error('feed alert push send error', err.statusCode, err.body || err.message);
      }
    }
  }
  return anyDelivered;
}

/**
 * Checks every enabled channel's feed. A channel's very first server-
 * side check imports its current videos as already-handled (mirrors the
 * client's own first-sync rule, applied independently here since the
 * server has no visibility into the client's local first-sync state) —
 * otherwise adding a channel would immediately fire a notification for
 * every one of its existing videos. One channel's failure is recorded
 * and never blocks the rest.
 */
async function checkAllFeedChannels(db, fetchChannelFeed) {
  const channels = await db.listFeedChannels();
  for (const channel of channels.filter((c) => c.enabled)) {
    // Captured before recordChannelCheckResult below updates it — a channel
    // that returned zero videos on its very first check must still count
    // as "already checked," or the next check (now with videos) would
    // wrongly re-trigger first-sync suppression again.
    const isFirstCheck = channel.last_checked_at === null || channel.last_checked_at === undefined;

    const { entries, error } = await fetchChannelFeed(channel.youtube_channel_id);

    if (!entries) {
      await db.recordChannelCheckResult(channel.id, { success: false, error: error || 'Feed check failed.' });
      continue;
    }

    const existingIds = await db.getSeenVideoIds(channel.id);
    const freshEntries = entries.filter((e) => !existingIds.has(e.videoId));

    if (isFirstCheck) {
      await db.insertInitialImport(channel.id, channel.name, entries);
    } else if (freshEntries.length > 0) {
      await db.insertPendingVideos(channel.id, channel.name, freshEntries);
    }

    await db.recordChannelCheckResult(channel.id, { success: true, error: null });
  }
}

/**
 * The full scheduled run: check feeds, then decide what (if anything)
 * to send. Global-disabled and per-channel-muted videos are marked
 * handled immediately so re-enabling later doesn't dump a backlog.
 * Quiet hours queue everything for the next run rather than dropping it
 * — the next run after quiet hours end will pick queued items back up
 * automatically since they're still "actionable."
 */
async function runFeedAlertsCheck({ db, webpush, fetchChannelFeed }) {
  await checkAllFeedChannels(db, fetchChannelFeed);
  await db.recordGlobalCheck();

  const settings = await db.getFeedNotificationSettings();
  const channels = await db.listFeedChannels();
  const channelById = new Map(channels.map((c) => [c.id, c]));

  let actionable = await db.listActionableVideos();

  for (const video of actionable) {
    const channel = channelById.get(video.feed_channel_id);
    if (!settings.global_enabled) {
      await db.setVideoStatus(video.youtube_video_id, 'suppressed_disabled', { notified: true });
    } else if (channel && !channel.notify_enabled) {
      await db.setVideoStatus(video.youtube_video_id, 'suppressed_channel_muted', { notified: true });
    }
  }

  if (!settings.global_enabled) return { sent: 0, queued: 0 };

  actionable = (await db.listActionableVideos()).filter((v) => {
    const channel = channelById.get(v.feed_channel_id);
    return channel ? channel.notify_enabled : true;
  });
  if (actionable.length === 0) return { sent: 0, queued: 0 };

  const now = new Date();
  const quiet = isWithinQuietHours(now, settings.quiet_hours_start, settings.quiet_hours_end, settings.timezone);

  if (quiet) {
    for (const video of actionable) {
      if (video.notification_status !== 'queued_quiet_hours') {
        await db.setVideoStatus(video.youtube_video_id, 'queued_quiet_hours');
      }
    }
    return { sent: 0, queued: actionable.length };
  }

  const subscriptions = await db.listSubscriptions();

  if (settings.digest_mode) {
    const payload = buildDigestPayload(actionable);
    const anyDelivered = await sendToAllSubscriptions(webpush, db, subscriptions, payload);
    const shouldMark = shouldMarkNotified(subscriptions.length, anyDelivered);
    if (shouldMark) {
      for (const video of actionable) {
        await db.setVideoStatus(video.youtube_video_id, 'sent_digest', { notified: true, deliveryResult: 'ok' });
      }
      await db.recordGlobalNotification();
    }
    return { sent: shouldMark ? actionable.length : 0, queued: 0 };
  }

  let sentCount = 0;
  for (const video of actionable) {
    const payload = buildVideoNotificationPayload(video);
    const anyDelivered = await sendToAllSubscriptions(webpush, db, subscriptions, payload);
    if (shouldMarkNotified(subscriptions.length, anyDelivered)) {
      await db.setVideoStatus(video.youtube_video_id, 'sent', { notified: true, deliveryResult: 'ok' });
      sentCount += 1;
    }
    // If not marked, it stays pending — retried next scheduled run.
  }
  if (sentCount > 0) await db.recordGlobalNotification();
  return { sent: sentCount, queued: 0 };
}

/** Manual Test Feed Alert — bypasses quiet hours and dedup entirely; it's an explicit, one-off request. */
async function sendTestAlert(db, webpush) {
  const subscriptions = await db.listSubscriptions();
  const payload = {
    title: 'Project Gorilla',
    body: 'Test Feed Alert \u2014 if you see this, alerts are working.',
    data: { type: 'feed-test' },
  };
  const anyDelivered = await sendToAllSubscriptions(webpush, db, subscriptions, payload);
  return { delivered: anyDelivered, subscriptionCount: subscriptions.length };
}

module.exports = { runFeedAlertsCheck, checkAllFeedChannels, sendToAllSubscriptions, sendTestAlert };
