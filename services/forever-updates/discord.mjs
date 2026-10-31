import {
  classifySource,
  officialArticleUrl,
  plain,
} from './core.mjs';

const FORUM_BASE = 'https://us.forums.blizzard.com/en/wow';
const UPDATE_EXCERPT_MAX = 850;

function updateExcerpt(post) {
  const html = String(post?.cooked || post?.excerpt || '')
    .replace(/<\/(?:p|li|blockquote|h[1-6])>/gi, ' FOREVERPARABREAK ')
    .replace(/<br\s*\/?>/gi, ' FOREVERLINEBREAK ');

  let text = plain(html)
    .replace(/\s*FOREVERPARABREAK\s*/g, '\n\n')
    .replace(/\s*FOREVERLINEBREAK\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const title = plain(
    post?.topic_title || post?.topic?.title || post?.title || '',
  );
  if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
    text = text.slice(title.length).trim();
  }

  if (text.length <= UPDATE_EXCERPT_MAX) return text;

  const clipped = text.slice(0, UPDATE_EXCERPT_MAX - 1);
  const boundary = Math.max(
    clipped.lastIndexOf('\n\n'),
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf(' '),
  );
  const safe = boundary >= UPDATE_EXCERPT_MAX * 0.65
    ? clipped.slice(0, boundary).trimEnd()
    : clipped.trimEnd();

  return `${safe}…`;
}

function roleMention(roleId) {
  const id = /^\d{15,22}$/.test(String(roleId || '').trim())
    ? String(roleId).trim()
    : null;
  return {
    content: id ? `<@&${id}>` : undefined,
    allowed_mentions: id ? { parse: [], roles: [id] } : { parse: [] },
  };
}

function forumUrl(post) {
  if (post?.url) {
    return post.url.startsWith('http')
      ? post.url
      : `${FORUM_BASE}${post.url}`;
  }

  const postNo = post?.post_number || 1;
  return (
    `${FORUM_BASE}/t/${post?.topic_slug || post?.slug || 'topic'}/` +
    `${post?.topic_id}/${postNo}`
  );
}

export async function sendUpdate(
  webhookUrl,
  post,
  fetchImpl = fetch,
  mentionRoleId = null,
) {
  const source = classifySource(post);
  const officialUrl = officialArticleUrl(post);
  const pageUrl = officialUrl || forumUrl(post);
  const description = updateExcerpt(post);

  const mention = roleMention(mentionRoleId);
  const payload = {
    username: 'Forever Updates',
    content: mention.content,
    allowed_mentions: mention.allowed_mentions,
    embeds: [{
      title: plain(
        post?.topic_title || post?.topic?.title || 'New Blizzard update',
      ).slice(0, 256),
      url: pageUrl,
      description: description || 'New Blizzard-authored WoW Forever update.',
      author: {
        name: post?.name || post?.username || 'Blizzard',
      },
      timestamp: post?.created_at || new Date().toISOString(),
      footer: {
        text: `WoW Forever • ${source}`,
      },
      fields: officialUrl
        ? [{
            name: 'Forum mirror',
            value: `[Open discussion](${forumUrl(post)})`,
            inline: false,
          }]
        : [],
    }],
  };

  const separator = webhookUrl.includes('?') ? '&' : '?';
  const response = await fetchImpl(`${webhookUrl}${separator}wait=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverUpdates/2.0 (cloudflare-worker)',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Discord send -> HTTP ${response.status}`);
  }
}

export async function sendGapWarning(
  webhookUrl,
  { lastSeenId, oldestAvailableId, newestAvailableId },
  fetchImpl = fetch,
  mentionRoleId = null,
) {
  const mention = roleMention(mentionRoleId);
  const payload = {
    username: 'Forever Updates',
    content: mention.content,
    allowed_mentions: mention.allowed_mentions,
    embeds: [{
      title: '⚠️ Forever update collector detected a tracker gap',
      description:
        'The Blizzard Blue Tracker window advanced beyond the collector\'s last saved post. ' +
        'The currently available posts were processed, but one or more older Blizzard posts may have been missed.',
      fields: [
        { name: 'Last saved post', value: String(lastSeenId), inline: true },
        { name: 'Oldest available', value: String(oldestAvailableId), inline: true },
        { name: 'Newest available', value: String(newestAvailableId), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  };

  const separator = webhookUrl.includes('?') ? '&' : '?';
  const response = await fetchImpl(`${webhookUrl}${separator}wait=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverUpdates/2.0 (cloudflare-worker)',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Discord gap warning -> HTTP ${response.status}`);
  }
}


export async function sendWowheadUpdate(
  webhookUrl,
  article,
  fetchImpl = fetch,
  mentionRoleId = null,
) {
  const mention = roleMention(mentionRoleId);
  const payload = {
    username: 'Forever Updates',
    content: mention.content,
    allowed_mentions: mention.allowed_mentions,
    embeds: [{
      title: plain(article.title).slice(0, 256),
      url: article.url,
      description: plain(article.summary).slice(0, 850) || 'New Wowhead Forever article.',
      author: { name: article.author || 'Wowhead' },
      timestamp: article.created_at,
      footer: { text: 'WoW Forever • Wowhead News' },
    }],
  };

  const separator = webhookUrl.includes('?') ? '&' : '?';
  const response = await fetchImpl(webhookUrl + separator + 'wait=true', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverUpdates/2.0 (cloudflare-worker)',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error('Discord Wowhead send -> HTTP ' + response.status);
  }
}
