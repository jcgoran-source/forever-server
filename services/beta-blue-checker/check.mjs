const TRACKER_URL = 'https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json';
const FORUM_BASE = 'https://us.forums.blizzard.com/en/wow';
const CATEGORY_ID = 349;
const STATE_PREFIX = 'ForeverBlueposts:last=';

const NAMED_ENTITIES = {
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

function decodeHtmlEntities(text = '') {
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
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function plain(text = '') {
  return decodeHtmlEntities(
    String(text)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function trackerPosts(data) {
  const direct =
    data?.latest_posts ||
    data?.post_stream?.posts ||
    data?.posts;

  if (Array.isArray(direct)) return direct;

  if (Array.isArray(data?.user_actions)) {
    return data.user_actions.map((a) => a?.post || {
      id: a.post_id,
      topic_id: a.topic_id,
      post_number: a.post_number,
      username: a.username,
      name: a.name,
      excerpt: a.excerpt,
      cooked: a.cooked,
      created_at: a.created_at,
      slug: a.slug,
    }).filter((p) => p?.id && p?.topic_id);
  }

  return [];
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'ForeverBluepostDiscord/1.2 (+GitHub Actions)',
    },
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

function parseWebhookState(webhook) {
  const m = String(webhook?.name || '').match(/^ForeverBlueposts:last=(\d+)$/);
  return m ? Number(m[1]) : null;
}

async function getWebhook(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'ForeverBluepostDiscord/1.2 (+GitHub Actions)' },
  });
  if (!r.ok) throw new Error(`Discord webhook metadata -> HTTP ${r.status}`);
  return r.json();
}

async function setWebhookState(url, postId) {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverBluepostDiscord/1.2 (+GitHub Actions)',
    },
    body: JSON.stringify({ name: `${STATE_PREFIX}${postId}` }),
  });
  if (!r.ok) throw new Error(`Discord webhook state update -> HTTP ${r.status}`);
}

async function sendDiscord(url, post, topic) {
  const postNo = post.post_number || 1;
  const pageUrl = `${FORUM_BASE}/t/${topic.slug || post.slug || 'topic'}/${post.topic_id}/${postNo}`;
  const description = plain(post.cooked || post.excerpt || '').slice(0, 3500);
  const payload = {
    username: 'Forever Blueposts',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: plain(topic.title || 'New Blizzard post').slice(0, 256),
      url: pageUrl,
      description: description || 'New Blizzard post in the WoW: Forever Beta forum.',
      author: { name: post.name || post.username || 'Blizzard' },
      timestamp: post.created_at || new Date().toISOString(),
      footer: { text: 'WoW: Forever Beta • Blizzard Bluepost' },
    }],
  };

  const sep = url.includes('?') ? '&' : '?';
  const r = await fetch(`${url}${sep}wait=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverBluepostDiscord/1.2 (+GitHub Actions)',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Discord send -> HTTP ${r.status}`);
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL is not configured');

  const [tracker, webhook] = await Promise.all([
    getJson(TRACKER_URL),
    getWebhook(webhookUrl),
  ]);

  const posts = trackerPosts(tracker)
    .filter((p) => Number.isFinite(Number(p.id)) && p.topic_id)
    .sort((a, b) => Number(a.id) - Number(b.id));

  if (!posts.length) {
    const keys = tracker && typeof tracker === 'object' ? Object.keys(tracker).join(', ') : typeof tracker;
    throw new Error(`Blue Tracker returned no parseable posts. Top-level keys: ${keys}`);
  }

  const lastSeen = parseWebhookState(webhook);
  const newestTrackerId = Math.max(...posts.map((p) => Number(p.id)));

  if (lastSeen === null) {
    await setWebhookState(webhookUrl, newestTrackerId);
    console.log(`Bootstrapped at post ${newestTrackerId}; sent 0 historical posts.`);
    return;
  }

  const unseen = posts.filter((p) => Number(p.id) > lastSeen);
  if (!unseen.length) {
    console.log(`No new Blizzard posts since ${lastSeen}.`);
    return;
  }

  let sent = 0;
  for (const post of unseen) {
    const topic = await getJson(`${FORUM_BASE}/t/${post.topic_id}.json`);
    if (Number(topic.category_id) !== CATEGORY_ID) continue;
    await sendDiscord(webhookUrl, post, topic);
    sent += 1;
  }

  await setWebhookState(webhookUrl, newestTrackerId);
  console.log(`Processed ${unseen.length} new Blizzard post(s); sent ${sent} Forever post(s); state=${newestTrackerId}.`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
