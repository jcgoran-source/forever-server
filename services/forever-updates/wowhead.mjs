import { decodeHtmlEntities, plain } from './core.mjs';
import { sendWowheadUpdate } from './discord.mjs';

// This is Wowhead's Forever-only RSS feed, not its all-WoW news stream.
export const WOWHEAD_FOREVER_RSS_URL =
  'https://www.wowhead.com/news/rss/forever';

function xmlField(item, tag) {
  const pattern = new RegExp(
    '<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>',
    'i',
  );
  const match = item.match(pattern);
  if (!match) return '';
  return decodeHtmlEntities(
    match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'),
  ).trim();
}

function canonicalArticleUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !/^(?:www\.)?wowhead\.com$/i.test(url.hostname) ||
      !/^\/(?:forever\/)?news\/.+/i.test(url.pathname)
    ) return null;

    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function articleId(url) {
  const match = new URL(url).pathname.match(/-(\d{4,})\/?$/);
  return match ? match[1] : new URL(url).pathname.toLowerCase();
}

export function parseWowheadRss(xml) {
  if (!/<rss\b|<rdf:RDF\b/i.test(String(xml))) {
    throw new Error('Wowhead returned a non-RSS response.');
  }

  const items = [...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  if (!items.length) {
    throw new Error('Wowhead RSS has no article items (feed may have changed).');
  }

  const results = new Map();
  for (const [, item] of items) {
    const title = plain(xmlField(item, 'title'));
    const url = canonicalArticleUrl(xmlField(item, 'link'));
    const publishedMs = Date.parse(xmlField(item, 'pubDate'));
    if (!title || !url || !Number.isFinite(publishedMs)) continue;

    const id = articleId(url);
    if (results.has(id)) continue;

    results.set(id, {
      id,
      title,
      url,
      summary: plain(
        xmlField(item, 'description') || xmlField(item, 'content:encoded'),
      ),
      author: plain(
        xmlField(item, 'dc:creator') || xmlField(item, 'author'),
      ) || 'Wowhead',
      created_at: new Date(publishedMs).toISOString(),
    });
  }

  if (!results.size) {
    throw new Error('Wowhead RSS had no parseable, dated news articles.');
  }

  return [...results.values()].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

export function normalizeWowheadState(raw = {}) {
  return {
    version: 1,
    bootstrapped: raw.bootstrapped === true,
    recent_article_ids: Array.isArray(raw.recent_article_ids)
      ? raw.recent_article_ids.map(String).slice(-500)
      : [],
    updated_at: raw.updated_at || null,
    last_sent_at: raw.last_sent_at || null,
  };
}

async function fetchWowheadRss(fetchImpl) {
  const response = await fetchImpl(WOWHEAD_FOREVER_RSS_URL, {
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml',
      'cache-control': 'no-cache',
      'user-agent': 'ForeverUpdates/2.0 (cloudflare-worker)',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error('Wowhead RSS -> HTTP ' + response.status);
  }
  return parseWowheadRss(await response.text());
}

export async function collectWowheadUpdates({
  stateStore,
  webhookUrl,
  fetchImpl = fetch,
  now = new Date(),
  onRelevantArticle = null,
  mentionRoleId = null,
}) {
  if (!webhookUrl) {
    throw new Error('DISCORD_FOREVER_UPDATES_WEBHOOK_URL is not configured');
  }

  const [articles, rawState] = await Promise.all([
    fetchWowheadRss(fetchImpl),
    stateStore.get(),
  ]);
  let state = normalizeWowheadState(rawState);
  const nowIso = now.toISOString();

  // The separate cursor prevents a first-run flood and never resets the
  // existing Blizzard tracker cursor.
  if (!state.bootstrapped) {
    state = {
      ...state,
      bootstrapped: true,
      recent_article_ids: articles.map((article) => article.id).slice(-500),
      updated_at: nowIso,
    };
    await stateStore.put(state);
    return { bootstrapped: true, processed: 0, sent: 0, state };
  }

  const seen = new Set(state.recent_article_ids);
  const unseen = articles.filter((article) => !seen.has(article.id));
  let sent = 0;

  for (const article of unseen) {
    if (onRelevantArticle) await onRelevantArticle(article);
    await sendWowheadUpdate(webhookUrl, article, fetchImpl, mentionRoleId);

    seen.add(article.id);
    sent += 1;

    // Checkpoint after every successful delivery. Partial feed failures
    // cannot replay messages that were already sent in this poll.
    state = {
      ...state,
      recent_article_ids: [...seen].slice(-500),
      updated_at: nowIso,
      last_sent_at: nowIso,
    };
    await stateStore.put(state);
  }

  return {
    bootstrapped: false,
    processed: unseen.length,
    sent,
    state,
  };
}
