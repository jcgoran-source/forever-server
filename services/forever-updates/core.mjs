export const FOREVER_CATEGORY_IDS = new Set([347, 348, 349]);

const FOREVER_PATTERN =
  /\b(?:world\s+of\s+warcraft\s*:\s*forever|wow\s*:?\s*forever|warcraft\s*:\s*forever)\b/i;

export function decodeHtmlEntities(text = '') {
  const named = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    hellip: '…',
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
  };

  return String(text).replace(
    /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi,
    (match, entity) => {
      if (entity[0] === '#') {
        const hex = entity[1]?.toLowerCase() === 'x';
        const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (Number.isInteger(value) && value >= 0 && value <= 0x10ffff) {
          try {
            return String.fromCodePoint(value);
          } catch {
            return match;
          }
        }
        return match;
      }
      return named[entity.toLowerCase()] ?? match;
    },
  );
}

export function plain(text = '') {
  return decodeHtmlEntities(
    String(text)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function trackerPosts(data) {
  const direct = data?.latest_posts || data?.post_stream?.posts || data?.posts;
  if (Array.isArray(direct)) return direct;

  if (Array.isArray(data?.user_actions)) {
    return data.user_actions
      .map((a) => a?.post || {
        id: a.post_id,
        topic_id: a.topic_id,
        post_number: a.post_number,
        username: a.username,
        name: a.name,
        excerpt: a.excerpt,
        cooked: a.cooked,
        created_at: a.created_at,
        slug: a.slug,
        category_id: a.category_id,
        topic_title: a.topic_title,
      })
      .filter((post) => post?.id && post?.topic_id);
  }

  return [];
}

export function isForeverRelevant(post) {
  if (FOREVER_CATEGORY_IDS.has(Number(post?.category_id))) return true;

  const haystack = [
    post?.topic_title,
    post?.topic_html_title,
    post?.title,
    post?.cooked,
    post?.excerpt,
  ]
    .filter(Boolean)
    .join('\n');

  return FOREVER_PATTERN.test(plain(haystack));
}

export function normalizedFingerprint(post) {
  const title = plain(
    post?.topic_title || post?.topic?.title || post?.title || '',
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const body = plain(post?.cooked || post?.excerpt || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 280);

  return `${title}|${body}`;
}

export function officialArticleUrl(post) {
  const html = String(post?.cooked || post?.excerpt || '');
  const match = html.match(
    /https?:\/\/(?:worldofwarcraft\.blizzard\.com|worldofwarcraft\.com)\/[^"'<>\s]*\/news\/\d+[^"'<>\s]*/i,
  );
  return match?.[0]?.replace(/&amp;/g, '&') || null;
}

export function classifySource(post) {
  if (
    post?.username === 'BlizzardEntertainment' ||
    post?.user_title === 'Blizzard News' ||
    post?.primary_group_name === 'api_users'
  ) {
    return 'Blizzard News';
  }

  if (FOREVER_CATEGORY_IDS.has(Number(post?.category_id))) {
    return 'Forever Forum Bluepost';
  }

  return 'Forever-Relevant Bluepost';
}

export function normalizeState(raw = {}) {
  return {
    version: 1,
    last_seen_id: Number.isFinite(Number(raw.last_seen_id))
      ? Number(raw.last_seen_id)
      : null,
    recent_fingerprints: Array.isArray(raw.recent_fingerprints)
      ? raw.recent_fingerprints.slice(-100)
      : [],
    updated_at: raw.updated_at || null,
    last_sent_at: raw.last_sent_at || null,
  };
}
