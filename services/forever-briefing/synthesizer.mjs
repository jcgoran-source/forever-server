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

export const BRIEFING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BRIEFING_SLOT_HOURS = [18];
export const BRIEFING_TIME_ZONE = 'America/Los_Angeles';
export const BRIEFING_SLOT_GRACE_MINUTES = 10;

function pacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIEFING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function briefingSlotKey(date = new Date()) {
  const parts = pacificParts(date);
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
    String(BRIEFING_SLOT_HOURS[0]).padStart(2, '0'),
  ].join('-');
}

function insideBriefingSlotWindow(date = new Date()) {
  const parts = pacificParts(date);
  return (
    BRIEFING_SLOT_HOURS.includes(parts.hour) &&
    parts.minute < BRIEFING_SLOT_GRACE_MINUTES
  );
}

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

export function synthesizeWowheadArticle(article) {
  const title = plain(article.title);
  const summary = plain(article.summary);
  const text = title + '\n' + summary;
  const categories = categoriesFor(text);
  return {
    id: 'wowhead:' + article.id,
    article_id: String(article.id),
    post_id: null,
    topic_id: null,
    created_at: article.created_at,
    title,
    summary: summary.slice(0, 420) || title,
    source: 'Wowhead News',
    url: article.url,
    forum_url: null,
    categories,
    primary_category: categories[0],
    priority: priorityFor(text, categories),
  };
}

export function ingestWowheadIntoState(
  rawState,
  article,
  now = new Date(),
) {
  const state = normalizeBriefingState(rawState);
  const change = synthesizeWowheadArticle(article);
  if (state.changes.some((item) => item.id === change.id)) {
    return { state, change: null, duplicate: true };
  }
  const nowIso = now.toISOString();
  return {
    state: {
      ...state,
      changes: [...state.changes, change].slice(-500),
      pending_change_ids: [...state.pending_change_ids, change.id].slice(-250),
      first_pending_at: state.first_pending_at || nowIso,
      last_change_at: nowIso,
      updated_at: nowIso,
    },
    change,
    duplicate: false,
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
    last_brief_slot: raw.last_brief_slot || null,
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
) {
  const state = normalizeBriefingState(stateRaw);
  if (!state.pending_change_ids.length) return false;

  const now = new Date(nowMs);
  if (!insideBriefingSlotWindow(now)) return false;

  const firstPendingMs = Date.parse(state.first_pending_at || '');
  if (!Number.isFinite(firstPendingMs)) return false;

  const currentSlot = briefingSlotKey(now);
  const firstPendingSlot = briefingSlotKey(new Date(firstPendingMs));
  const lastBriefSlot =
    state.last_brief_slot ||
    (state.last_brief_at
      ? briefingSlotKey(new Date(state.last_brief_at))
      : null);

  // Before 6 PM Pacific, an update qualifies for today's briefing.
  // At or after 6 PM it must wait for the following day's slot.
  // Compare Pacific local calendar days to remain DST-safe.
  const firstPendingParts = pacificParts(new Date(firstPendingMs));
  const eligibleForCurrentSlot =
    firstPendingSlot < currentSlot ||
    (firstPendingSlot === currentSlot &&
      firstPendingParts.hour < BRIEFING_SLOT_HOURS[0]);

  return eligibleForCurrentSlot && lastBriefSlot !== currentSlot;
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
    last_brief_slot: briefingSlotKey(now),
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
