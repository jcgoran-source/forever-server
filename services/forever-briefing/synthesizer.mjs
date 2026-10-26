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

const FOCUS_RULES = [
  {
    relevance: 'high',
    tags: ['Mage/Frost'],
    pattern: /\b(mage|frostbolt|frost nova|cone of cold|blizzard|ice barrier|frost)\b/i,
    reason: 'Touches Mage/Frost directly.',
  },
  {
    relevance: 'high',
    tags: ['Launch operations'],
    pattern: /\b(launch|release|login|queue|server|realm|maintenance|downtime|restart|reservation)\b/i,
    reason: 'Could change launch-day access, timing, or server conditions.',
  },
  {
    relevance: 'high',
    tags: ['Launch route'],
    pattern: /\b(durotar|barrens|ragefire|wailing caverns|quest|flight path)\b/i,
    reason: 'Could affect the planned early Horde leveling route.',
  },
  {
    relevance: 'medium',
    tags: ['Professions'],
    pattern: /\b(tailor(?:ing)?|skinning|enchant(?:ing)?|profession|recipe|crafting)\b/i,
    reason: 'Could affect the planned profession path or early economy.',
  },
  {
    relevance: 'medium',
    tags: ['Early dungeons'],
    pattern: /\b(shadowfang|blackfathom|deadmines|dungeon|instance)\b/i,
    reason: 'Could affect opportunistic early dungeon routing.',
  },
  {
    relevance: 'medium',
    tags: ['PvP'],
    pattern: /\b(pvp|honor|battleground|world pvp|layer|layering)\b/i,
    reason: 'Could affect the intended PvP-server experience.',
  },
];

const PRIORITY_WEIGHT = { high: 3, medium: 2, normal: 1 };

export const QUIET_PERIOD_MS = 10 * 60 * 1000;
export const MAX_BRIEF_DELAY_MS = 6 * 60 * 60 * 1000;

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

function focusFor(text) {
  const matches = FOCUS_RULES.filter((rule) => rule.pattern.test(text));
  if (!matches.length) {
    return {
      relevance: 'none',
      tags: [],
      reason: null,
    };
  }

  const order = { high: 3, medium: 2, low: 1, none: 0 };
  const relevance = matches
    .map((match) => match.relevance)
    .sort((a, b) => order[b] - order[a])[0];

  return {
    relevance,
    tags: [...new Set(matches.flatMap((match) => match.tags))],
    reason: [...new Set(matches.map((match) => match.reason))].join(' '),
  };
}

function priorityFor(text, categories, focus) {
  if (
    /\b(outage|offline|emergency|rollback|breaking|critical|maintenance|downtime|login issue|queue)\b/i.test(text)
  ) return 'high';

  if (
    focus.relevance === 'high' ||
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
  const focus = focusFor(text);

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
    priority: priorityFor(text, categories, focus),
    focus,
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
    updated_at: raw.updated_at || null,
  };
}

export function ingestPostIntoState(rawState, post, now = new Date()) {
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
    pending_change_ids: [...state.pending_change_ids, change.id].slice(-250),
    last_change_at: nowIso,
    first_pending_at: state.first_pending_at || nowIso,
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
  {
    quietPeriodMs = QUIET_PERIOD_MS,
    maxDelayMs = MAX_BRIEF_DELAY_MS,
  } = {},
) {
  const state = normalizeBriefingState(stateRaw);
  if (!state.pending_change_ids.length) return false;

  const lastChangeMs = Date.parse(state.last_change_at || '');
  const firstPendingMs = Date.parse(state.first_pending_at || '');

  const quietEnough =
    Number.isFinite(lastChangeMs) &&
    nowMs - lastChangeMs >= quietPeriodMs;

  const waitedLongEnough =
    Number.isFinite(firstPendingMs) &&
    nowMs - firstPendingMs >= maxDelayMs;

  return quietEnough || waitedLongEnough;
}

export function buildBriefing(stateRaw, now = new Date()) {
  const state = normalizeBriefingState(stateRaw);
  const changes = pendingChanges(state)
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

  const focus = changes
    .filter((change) => change.focus?.relevance === 'high' || change.focus?.relevance === 'medium')
    .sort((a, b) => {
      const order = { high: 2, medium: 1, none: 0 };
      return order[b.focus.relevance] - order[a.focus.relevance];
    });

  return {
    sequence: state.brief_sequence + 1,
    generated_at: now.toISOString(),
    change_count: changes.length,
    groups: [...grouped.entries()].map(([category, items]) => ({
      category,
      items,
    })),
    focus,
  };
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
