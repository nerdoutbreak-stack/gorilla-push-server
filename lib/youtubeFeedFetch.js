/**
 * PROJECT GORILLA PUSH SERVER — YouTube feed fetch (server side)
 * Same parsing rules and channel-ID validation as
 * netlify/functions/youtube-feed.js on the app side — duplicated rather
 * than shared because these are two separate deployable services with
 * no shared package. Kept intentionally small and dependency-free.
 */

const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const MAX_ENTRIES = 15;
const FETCH_TIMEOUT_MS = 10000;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseEntries(xml) {
  const entries = [];
  const entryBlocks = xml.split('<entry>').slice(1);

  for (const block of entryBlocks.slice(0, MAX_ENTRIES)) {
    const titleMatch =
      block.match(/<media:title>([\s\S]*?)<\/media:title>/) || block.match(/<title>([\s\S]*?)<\/title>/);
    const videoIdMatch = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);

    if (!titleMatch || !videoIdMatch) continue;
    const videoId = videoIdMatch[1].trim();

    entries.push({
      videoId,
      title: decodeEntities(titleMatch[1]),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: publishedMatch ? publishedMatch[1].trim() : null,
    });
  }

  return entries;
}

/** Fetches and parses one channel's feed. Never throws — returns { entries, error }. */
async function fetchChannelFeed(channelId) {
  if (!CHANNEL_ID_PATTERN.test(channelId)) {
    return { entries: null, error: 'Invalid channel ID shape.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FEED_URL}${encodeURIComponent(channelId)}`, { signal: controller.signal });
    if (!res.ok) return { entries: null, error: `YouTube feed returned ${res.status}.` };
    const xml = await res.text();
    return { entries: parseEntries(xml), error: null };
  } catch (err) {
    return { entries: null, error: err instanceof Error ? err.message : 'Feed fetch failed.' };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchChannelFeed, CHANNEL_ID_PATTERN };
