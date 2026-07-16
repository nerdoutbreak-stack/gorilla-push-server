/**
 * PROJECT GORILLA PUSH SERVER — notification decision logic
 * Pure function, no I/O — kept separate from the database and push
 * delivery code specifically so it can be unit tested without a real
 * Postgres connection or a real push service.
 */

/**
 * @param {Array<{id: string, due_date: string, notified_at: string|null}>} followups
 * @param {Date} now
 * @returns {Array} the subset that is due/overdue and hasn't been notified yet
 */
function selectDueForNotification(followups, now) {
  return followups.filter((f) => !f.notified_at && new Date(f.due_date) <= now);
}

/**
 * Builds the push payload for one follow-up. Kept short — push payloads
 * have a real size ceiling, and a notification should be scannable at a
 * glance, not a full briefing.
 */
function buildNotificationPayload(followup) {
  const title = 'Project Gorilla — follow-up due';
  const body = followup.contact_name
    ? `${followup.contact_name}: ${followup.description}`
    : followup.description;
  return { title, body: body.slice(0, 180) };
}

/**
 * Decides whether a followup should be marked notified after attempting
 * delivery to every currently-stored subscription.
 * - No subscriptions existed yet: don't mark — retry once someone subscribes.
 * - At least one delivery actually succeeded: mark notified.
 * - Subscriptions existed but every attempt failed (bad VAPID key, server
 *   misconfigured, etc): don't mark — retry once the problem is fixed,
 *   rather than silently losing the notification.
 */
function shouldMarkNotified(subscriptionCount, anyDelivered) {
  if (subscriptionCount === 0) return false;
  return anyDelivered === true;
}

module.exports = { selectDueForNotification, buildNotificationPayload, shouldMarkNotified };
