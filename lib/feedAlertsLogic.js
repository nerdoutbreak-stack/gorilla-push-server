/**
 * PROJECT GORILLA PUSH SERVER — Feed Alerts decision logic
 * Pure functions, no I/O — same discipline as notifyLogic.js, kept
 * separate specifically so quiet-hours math and payload shaping can be
 * unit tested without a real Postgres connection or push service.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Returns "HH:MM" for `date` in the given IANA timezone. Falls back to UTC on an invalid zone. */
function localHHMM(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h}:${m}`;
  } catch {
    return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  }
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Quiet hours can wrap midnight (e.g. 22:00 -> 07:00). Both start and
 * end must be set for quiet hours to apply at all — either missing
 * means quiet hours are off.
 */
function isWithinQuietHours(now, quietStart, quietEnd, timezone) {
  if (!quietStart || !quietEnd) return false;
  const nowMin = toMinutes(localHHMM(now, timezone));
  const startMin = toMinutes(quietStart);
  const endMin = toMinutes(quietEnd);

  if (startMin === endMin) return false; // zero-length window is effectively off
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Wraps midnight, e.g. 22:00 -> 07:00
  return nowMin >= startMin || nowMin < endMin;
}

function buildVideoNotificationPayload(video) {
  return {
    title: `New from ${video.channel_name}`,
    body: video.title.slice(0, 180),
    data: {
      type: 'feed-item',
      videoId: video.youtube_video_id,
      channelName: video.channel_name,
      videoUrl: video.video_url,
    },
  };
}

function buildDigestPayload(videos) {
  const channelNames = [...new Set(videos.map((v) => v.channel_name))];
  const summary =
    channelNames.length <= 2
      ? channelNames.join(' and ')
      : `${channelNames.slice(0, 2).join(', ')}, and ${channelNames.length - 2} more`;
  return {
    title: `${videos.length} new video${videos.length === 1 ? '' : 's'}`,
    body: `From ${summary}`,
    data: {
      type: 'feed-digest',
      videoIds: videos.map((v) => v.youtube_video_id),
    },
  };
}

module.exports = {
  isWithinQuietHours,
  buildVideoNotificationPayload,
  buildDigestPayload,
};
