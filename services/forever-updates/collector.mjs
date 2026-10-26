import {
  isForeverRelevant,
  normalizeState,
  normalizedFingerprint,
  trackerPosts,
} from './core.mjs';
import { sendGapWarning, sendUpdate } from './discord.mjs';

const TRACKER_URL =
  'https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json';
const FORUM_BASE = 'https://us.forums.blizzard.com/en/wow';

async function getJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': 'ForeverUpdates/2.0 (cloudflare-worker)',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }

  return response.json();
}

async function hydratePost(post, fetchImpl = fetch) {
  try {
    const full = await getJson(
      `${FORUM_BASE}/posts/${post.id}.json`,
      fetchImpl,
    );

    return {
      ...post,
      ...full,
      category_id: post.category_id ?? full.category_id,
      topic_title:
        post.topic_title ||
        full.topic_title ||
        full.topic?.title,
      topic_slug:
        post.topic_slug ||
        full.topic_slug ||
        full.topic?.slug,
      url: post.url || full.url,
    };
  } catch (error) {
    console.warn(
      `Could not hydrate Blizzard post ${post.id}; using tracker excerpt: ${error?.message || error}`,
    );
    return post;
  }
}

export async function collectForeverUpdates({
  stateStore,
  webhookUrl,
  fetchImpl = fetch,
  now = new Date(),
  onRelevantPost = null,
  mentionRoleId = null,
}) {
  if (!webhookUrl) {
    throw new Error('DISCORD_FOREVER_UPDATES_WEBHOOK_URL is not configured');
  }

  const [tracker, rawState] = await Promise.all([
    getJson(TRACKER_URL, fetchImpl),
    stateStore.get(),
  ]);

  const state = normalizeState(rawState);
  const posts = trackerPosts(tracker)
    .filter((post) => Number.isFinite(Number(post.id)) && post.topic_id)
    .sort((a, b) => Number(a.id) - Number(b.id));

  if (!posts.length) {
    const keys =
      tracker && typeof tracker === 'object'
        ? Object.keys(tracker).join(', ')
        : typeof tracker;
    throw new Error(
      `Blue Tracker returned no parseable posts. Top-level keys: ${keys}`,
    );
  }

  const ids = posts.map((post) => Number(post.id));
  const oldestAvailableId = Math.min(...ids);
  const newestAvailableId = Math.max(...ids);

  if (state.last_seen_id === null) {
    const next = {
      ...state,
      last_seen_id: newestAvailableId,
      updated_at: now.toISOString(),
    };
    await stateStore.put(next);
    console.log(
      `Bootstrapped Forever update collector at post ${newestAvailableId}; sent 0 historical posts.`,
    );
    return {
      bootstrapped: true,
      processed: 0,
      sent: 0,
      duplicates: 0,
      state: next,
    };
  }

  const gapDetected =
    state.last_seen_id < oldestAvailableId &&
    !ids.includes(state.last_seen_id);

  if (gapDetected) {
    await sendGapWarning(
      webhookUrl,
      {
        lastSeenId: state.last_seen_id,
        oldestAvailableId,
        newestAvailableId,
      },
      fetchImpl,
      mentionRoleId,
    );
  }

  const unseen = posts.filter(
    (post) => Number(post.id) > state.last_seen_id,
  );

  if (!unseen.length) {
    console.log(
      `No new Blizzard posts since ${state.last_seen_id}. Tracker window ${oldestAvailableId}-${newestAvailableId}.`,
    );
    return {
      bootstrapped: false,
      processed: 0,
      sent: 0,
      duplicates: 0,
      gapDetected,
      state,
    };
  }

  const fingerprints = new Set(state.recent_fingerprints);
  let sent = 0;
  let duplicates = 0;

  for (const trackerPost of unseen) {
    const post = await hydratePost(trackerPost, fetchImpl);

    if (!isForeverRelevant(post)) continue;

    const fingerprint = normalizedFingerprint(post);
    if (fingerprints.has(fingerprint)) {
      duplicates += 1;
      console.log(
        `Skipped duplicate Forever update ${post.id}: ${post.topic_title || post.topic?.title || 'untitled'}`,
      );
      continue;
    }

    if (onRelevantPost) {
      await onRelevantPost(post);
    }

    await sendUpdate(webhookUrl, post, fetchImpl, mentionRoleId);
    fingerprints.add(fingerprint);
    sent += 1;
  }

  const next = {
    version: 1,
    last_seen_id: newestAvailableId,
    recent_fingerprints: Array.from(fingerprints).slice(-100),
    updated_at: now.toISOString(),
    last_sent_at: sent ? now.toISOString() : state.last_sent_at,
  };

  await stateStore.put(next);

  console.log(
    `Processed ${unseen.length} new Blizzard post(s); sent ${sent} Forever update(s); duplicate suppressions=${duplicates}; state=${newestAvailableId}.`,
  );

  return {
    bootstrapped: false,
    processed: unseen.length,
    sent,
    duplicates,
    gapDetected,
    state: next,
  };
}
