import {
  classifySource,
  officialArticleUrl,
  plain,
} from '../forever-updates/core.mjs';

const CATEGORY_RULES = [
  ['Classes', [
    /\b(class|classes|talent|talents|spell|spells|ability|abilities)\b/i,
    /\b(mage|warrior|priest|rogue|hunter|warlock|shaman|paladin|druid)\b/i,
    /\b(frost|fire|arcane|holy|shadow|restoration|enhancement|elemental)\b/i,
  ]],
  ['Professions', [
    /\b(profession|professions|craft|crafting|recipe|recipes)\b/i,
    /\b(tailor(?:ing)?|enchant(?:ing)?|skinning|alchemy|herbalism|blacksmith(?:ing)?|engineering|leatherworking|mining|cooking|fishing)\b/i,
  ]],
  ['Dungeons & Raids', [
    /\b(dungeon|dungeons|raid|raids|boss|bosses|instance|instances)\b/i,
    /\b(ragefire|wailing caverns|deadmines|shadowfang|blackfathom|molten core|onyxia)\b/i,
  ]],
  ['PvP', [
    /\b(pvp|player versus player|battleground|battlegrounds|honor|arena|world pvp)\b/i,
  ]],
  ['Quests & World', [
    /\b(quest|quests|npc|npcs|spawn|spawns|zone|zones|flight path|world event)\b/i,
    /\b(durotar|barrens|stonetalon|ashenvale|silverpine|westfall|loch modan|wetlands)\b/i,
  ]],
  ['Items & Economy', [
    /\b(item|items|loot|drop|drops|vendor|vendors|auction|gold|currency|currencies|crate|crates|writ|writs)\b/i,
  ]],
  ['UI & Systems', [
    /\b(interface|ui|addon|addons|api|keybind|transmog|guild|mail|chat|layer|layering|shard|sharding)\b/i,
  ]],
  ['Launch & Servers', [
    /\b(launch|release|server|servers|realm|realms|login|maintenance|queue|queues|downtime|restart|restarts|reservation|reservations)\b/i,
  ]],
  ['Known Issues & Fixes', [
    /\b(known issue|known issues|bug|bugs|fix|fixes|fixed|hotfix|hotfixes|issue|issues|resolved|investigating|workaround)\b/i,
  ]],
];

const PRIORITY_WEIGHT = { high: 3, medium: 2, normal: 1 };

export const BRIEFING_INTERVAL_MS = 4 * 60 * 60 * 1000;

function forumUrl(post) {
  if (post?.url) {
    return String(post.url).startsWith('http')
      ? post.url
      : `https://us.forums.blizzard.com/en/wow${post.url}`;
  }

  const postNo = post?.post_number || 1;
  return (
    `https://us.forums.blizzard.com/en/wow/t/${post?.topic_slug || post?.slug || 'topic'}/` +
    `${post?.topic_id}/${postNo}`
  );
}

function extractSummary(post) {
  const title = plain(post?.topic_title || post?.topic?.title || post?.title || '');
  let body = plain(post?.cooked || post?.excerpt || '')
    .replace(/\bView Full Article\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (title && body.toLowerCase().startsWith(title.toLowerCase())) {
    body = body.slice(title.length).trim();
  }

  if (!body) return title || 'Blizzard update';

  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);

  const picked = [];
  let length = 0;
  for (const sentence of sentences) {
    if (picked.length >= 2) break;
    if (length + sentence.length > 360 && picked.length) break;
    picked.push(sentence);
    length += sentence.length;
  }

  return (picked.join(' ') || body).slice(0, 420);
}

function categoriesFor(text) {
  const scored = CATEGORY_RULES
    .map(([name, rules]) => [
      name,
      rules.reduce((score, rule) => score + (rule.test(text) ? 1 : 0), 0),
    ])
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  return scored.length
    ? scored.map(([name]) => name)
    : ['General'];
}

function priorityFor(text, categories) {
  if (
    /\b(outage|offline|emergency|rollback|breaking|critical|maintenance|downtime|login issue|queue)\b/i.test(text)
  ) return 'high';

  if (
    categories.includes('Known Issues & Fixes') ||
    categories.includes('Classes') ||
    categories.includes('Dungeons & Raids')
  ) return 'medium';

  return 'normal';
}

export function synthesizePost(post) {
  const title = plain(
    post?.topic_title || post?.topic?.title || post?.title || 'Blizzard update',
  );
  const summary = extractSummary(post);
  const text = `${title}\n${plain(post?.cooked || post?.excerpt || '')}`;
  const categories = categoriesFor(text);

  return {
    id: `post:${post.id}`,
    post_id: Number(post.id),
    topic_id: Number(post.topic_id),
    created_at: post.created_at || new Date().toISOString(),
    title,
    summary,
    source: classifySource(post),
    url: officialArticleUrl(post) || forumUrl(post),
    forum_url: forumUrl(post),
    categories,
    primary_category: categories[0],
    priority: priorityFor(text, categories),
  };
}

export function normalizeBriefingState(raw = {}) {
  return {
    version: 1,
    ingested_post_ids: Array.isArray(raw.ingested_post_ids)
      ? raw.ingested_post_ids.map(Number).filter(Number.isFinite).slice(-500)
      : [],
    changes: Array.isArray(raw.changes)
      ? raw.changes.slice(-500)
      : [],
    pending_change_ids: Array.isArray(raw.pending_change_ids)
      ? raw.pending_change_ids.slice(-250)
      : [],
    last_change_at: raw.last_change_at || null,
    first_pending_at: raw.first_pending_at || null,
    last_brief_at: raw.last_brief_at || null,
    brief_sequence: Number(raw.brief_sequence || 0),
    completed_backfills: Array.isArray(raw.completed_backfills)
      ? raw.completed_backfills.slice(-50)
      : [],
    updated_at: raw.updated_at || null,
  };
}

export function ingestPostIntoState(
  rawState,
  post,
  now = new Date(),
  { pending = true } = {},
) {
  const state = normalizeBriefingState(rawState);
  const postId = Number(post.id);

  if (state.ingested_post_ids.includes(postId)) {
    return { state, change: null, duplicate: true };
  }

  const change = synthesizePost(post);
  const nowIso = now.toISOString();

  const next = {
    ...state,
    ingested_post_ids: [...state.ingested_post_ids, postId].slice(-500),
    changes: [...state.changes, change].slice(-500),
    pending_change_ids: pending
      ? [...state.pending_change_ids, change.id].slice(-250)
      : state.pending_change_ids,
    last_change_at: pending ? nowIso : state.last_change_at,
    first_pending_at: pending
      ? (state.first_pending_at || nowIso)
      : state.first_pending_at,
    updated_at: nowIso,
  };

  return { state: next, change, duplicate: false };
}

export function pendingChanges(stateRaw) {
  const state = normalizeBriefingState(stateRaw);
  const wanted = new Set(state.pending_change_ids);
  return state.changes.filter((change) => wanted.has(change.id));
}

export function briefingDue(
  stateRaw,
  nowMs = Date.now(),
  { intervalMs = BRIEFING_INTERVAL_MS } = {},
) {
  const state = normalizeBriefingState(stateRaw);
  if (!state.pending_change_ids.length) return false;

  const firstPendingMs = Date.parse(state.first_pending_at || '');
  return (
    Number.isFinite(firstPendingMs) &&
    nowMs - firstPendingMs >= intervalMs
  );
}

export function buildBriefingFromChanges(
  changesRaw,
  sequence,
  now = new Date(),
  {
    kind = 'current',
    label = null,
    source_window = null,
  } = {},
) {
  const changes = [...changesRaw]
    .sort((a, b) =>
      (PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]) ||
      Date.parse(a.created_at) - Date.parse(b.created_at),
    );

  const grouped = new Map();
  for (const change of changes) {
    const key = change.primary_category || 'General';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(change);
  }


  return {
    sequence,
    kind,
    label,
    source_window,
    generated_at: now.toISOString(),
    change_count: changes.length,
    groups: [...grouped.entries()].map(([category, items]) => ({
      category,
      items,
    })),
  };
}

export function buildBriefing(stateRaw, now = new Date()) {
  const state = normalizeBriefingState(stateRaw);
  return buildBriefingFromChanges(
    pendingChanges(state),
    state.brief_sequence + 1,
    now,
  );
}

export function markBriefingSent(rawState, now = new Date()) {
  const state = normalizeBriefingState(rawState);
  return {
    ...state,
    pending_change_ids: [],
    first_pending_at: null,
    last_brief_at: now.toISOString(),
    brief_sequence: state.brief_sequence + 1,
    updated_at: now.toISOString(),
  };
}

export function markHistoricalBriefingSent(
  rawState,
  backfillKey,
  now = new Date(),
) {
  const state = normalizeBriefingState(rawState);
  return {
    ...state,
    completed_backfills: [
      ...state.completed_backfills.filter((key) => key !== backfillKey),
      backfillKey,
    ].slice(-50),
    last_brief_at: now.toISOString(),
    brief_sequence: state.brief_sequence + 1,
    updated_at: now.toISOString(),
  };
}
