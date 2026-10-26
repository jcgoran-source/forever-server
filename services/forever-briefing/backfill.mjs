import {
  isForeverRelevant,
  normalizedFingerprint,
  trackerPosts,
} from '../forever-updates/core.mjs';
import {
  buildBriefingFromChanges,
  ingestPostIntoState,
  normalizeBriefingState,
} from './synthesizer.mjs';

const TRACKER_URL =
  'https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json';
const FORUM_BASE = 'https://us.forums.blizzard.com/en/wow';

async function getJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': 'ForeverBriefingBackfill/1.0 (cloudflare-worker)',
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
      `Historical hydration failed for Blizzard post ${post.id}; using tracker excerpt: ${error?.message || error}`,
    );
    return post;
  }
}

export function selectHistoricalCandidates(
  posts,
  {
    sinceMs,
    untilMs = Date.now(),
    limit = 12,
  },
) {
  const ordered = posts
    .filter((post) => Number.isFinite(Number(post?.id)))
    .filter((post) => {
      const created = Date.parse(post?.created_at || '');
      return (
        Number.isFinite(created) &&
        created >= sinceMs &&
        created <= untilMs
      );
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const fingerprints = new Set();
  const unique = [];

  for (const post of ordered) {
    if (!isForeverRelevant(post)) continue;

    const fingerprint = normalizedFingerprint(post);
    if (fingerprints.has(fingerprint)) continue;

    fingerprints.add(fingerprint);
    unique.push(post);
  }

  return unique.slice(-Math.max(1, Math.min(50, Number(limit) || 12)));
}

export async function runHistoricalBackfill({
  rawState,
  since,
  limit = 12,
  fetchImpl = fetch,
  now = new Date(),
}) {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    throw new Error(`Invalid historical backfill start: ${since}`);
  }

  const tracker = await getJson(TRACKER_URL, fetchImpl);
  const trackerEntries = trackerPosts(tracker)
    .filter((post) => post?.topic_id);

  if (!trackerEntries.length) {
    throw new Error('Blizzard Blue Tracker returned no posts for backfill.');
  }

  const inWindow = trackerEntries
    .filter((post) => {
      const created = Date.parse(post?.created_at || '');
      return (
        Number.isFinite(created) &&
        created >= sinceMs &&
        created <= now.getTime()
      );
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const hydrated = [];
  for (const post of inWindow) {
    hydrated.push(await hydratePost(post, fetchImpl));
  }

  const selected = selectHistoricalCandidates(hydrated, {
    sinceMs,
    untilMs: now.getTime(),
    limit,
  });

  let state = normalizeBriefingState(rawState);
  const changes = [];
  const importedPosts = [];

  for (const post of selected) {
    const result = ingestPostIntoState(
      state,
      post,
      now,
      { pending: false },
    );

    state = result.state;

    if (!result.duplicate && result.change) {
      changes.push(result.change);
      importedPosts.push({
        id: Number(post.id),
        created_at: post.created_at,
        title: result.change.title,
      });
    }
  }

  const briefing = buildBriefingFromChanges(
    changes,
    state.brief_sequence + 1,
    now,
    {
      kind: 'historical',
      label: 'Controlled prelaunch backfill',
      source_window: `${since} → ${now.toISOString()}`,
    },
  );

  return {
    state,
    briefing,
    imported_posts: importedPosts,
    tracker_window_count: inWindow.length,
    selected_count: selected.length,
    imported_count: changes.length,
  };
}
