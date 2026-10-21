import { ageMs } from './core.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function decodeEntities(text = '') {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”',
  };

  return String(text).replace(
    /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi,
    (match, entity) => {
      if (entity[0] === '#') {
        const hex = entity[1]?.toLowerCase() === 'x';
        const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (Number.isInteger(value) && value >= 0 && value <= 0x10ffff) {
          try { return String.fromCodePoint(value); } catch { return match; }
        }
        return match;
      }
      return named[entity.toLowerCase()] ?? match;
    },
  );
}

export function htmlToText(html = '') {
  return decodeEntities(
    String(html)
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

async function fetchText(url, { userAgent, fetchImpl = fetch, ...options } = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': userAgent,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`\${url} -> HTTP \${response.status}`);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) },
  });
  return JSON.parse(text);
}

function parseServiceStatus(match) {
  if (!match) return null;
  const value = match[1].toLowerCase();
  if (['answering', 'up', 'online'].includes(value)) return true;
  if (['not answering', 'down', 'offline'].includes(value)) return false;
  return null;
}

function parseCheckedAt(match) {
  if (!match?.[2]) return null;
  const value = Date.parse(match[2]);
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

async function foreverDbProbe(profile, options) {
  const source = profile.foreverDb;
  const nowMs = options.nowMs;

  try {
    const separator = source.url.includes('?') ? '&' : '?';
    const html = await fetchText(
      `\${source.url}\${separator}_=\${nowMs}`,
      { ...options, headers: { accept: 'text/html' } },
    );
    const text = htmlToText(html);
    const statusPattern = '(Not answering|Answering|Offline|Online|Down|Up)';
    const loginLabel = escapeRegex(source.loginLabel);
    const realmLabel = escapeRegex(source.realmLabel);

    const loginMatch = text.match(
      new RegExp(
        `\${loginLabel}\\s+\${statusPattern}[\\s\\S]{0,220}?checked\\s+([0-9T:.+-]+Z?)`,
        'i',
      ),
    );
    const realmMatch = text.match(
      new RegExp(
        `\${realmLabel}\\s+\${statusPattern}[\\s\\S]{0,220}?checked\\s+([0-9T:.+-]+Z?)`,
        'i',
      ),
    );

    const maintenanceLabel = escapeRegex(source.maintenanceLabel);
    const maintenanceMatch = text.match(
      new RegExp(
        `\${maintenanceLabel}\\s*(.{0,400}?)(?:\${loginLabel}|$)`,
        'i',
      ),
    );

    const loginCheckedAt = parseCheckedAt(loginMatch);
    const realmCheckedAt = parseCheckedAt(realmMatch);
    const login = parseServiceStatus(loginMatch);
    const realm = parseServiceStatus(realmMatch);

    const loginFresh =
      login !== null &&
      loginCheckedAt !== null &&
      ageMs(loginCheckedAt, nowMs) <= profile.thresholds.foreverDbMaxAgeMs;
    const realmFresh =
      realm !== null &&
      realmCheckedAt !== null &&
      ageMs(realmCheckedAt, nowMs) <= profile.thresholds.foreverDbMaxAgeMs;

    const problems = [];
    if (login === null) problems.push('login status missing');
    if (realm === null) problems.push('realm status missing');
    if (!loginCheckedAt) problems.push('login timestamp missing');
    if (!realmCheckedAt) problems.push('realm timestamp missing');
    if (loginCheckedAt && !loginFresh) problems.push('login result stale');
    if (realmCheckedAt && !realmFresh) problems.push('realm result stale');

    return {
      login,
      realm,
      login_checked_at: loginCheckedAt,
      realm_checked_at: realmCheckedAt,
      login_fresh: loginFresh,
      realm_fresh: realmFresh,
      maintenance: maintenanceMatch?.[1]?.trim() || null,
      error: problems.length ? problems.join('; ') : null,
    };
  } catch (error) {
    return {
      login: null, realm: null,
      login_checked_at: null, realm_checked_at: null,
      login_fresh: false, realm_fresh: false,
      maintenance: null,
      error: String(error?.message || error),
    };
  }
}

function trackerPosts(data) {
  const direct = data?.latest_posts || data?.post_stream?.posts || data?.posts;
  if (Array.isArray(direct)) return direct;
  if (Array.isArray(data?.user_actions)) {
    return data.user_actions
      .map((a) => a?.post || {
        id: a.post_id, topic_id: a.topic_id, post_number: a.post_number,
        username: a.username, name: a.name, excerpt: a.excerpt,
        cooked: a.cooked, created_at: a.created_at, slug: a.slug,
      })
      .filter((post) => post?.id && post?.topic_id);
  }
  return [];
}

function classifyOfficialText(profile, text) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const subject = profile.forum.subjectPattern;

  if (/coming back online imminently|back online imminently|re-?open(?:ing)? shortly|back shortly/i.test(normalized)) {
    return 'transition';
  }

  if (
    new RegExp(
      `\\b\${subject}\\b.{0,100}\\b(is back|are back|back online|back up|is up|are up|re-?opened|online now)\\b`,
      'i',
    ).test(normalized) ||
    new RegExp(
      `\\b(back online|back up|re-?opened)\\b.{0,100}\\b\${subject}\\b`,
      'i',
    ).test(normalized)
  ) return 'online';

  if (
    new RegExp(
      `\\b(take|taking|took|bring|bringing)\\b.{0,100}\\b\${subject}\\b.{0,80}\\b(offline|down)\\b`,
      'i',
    ).test(normalized) ||
    new RegExp(
      `\\b\${subject}\\b.{0,100}\\b(offline|down|shut ?down)\\b`,
      'i',
    ).test(normalized)
  ) return 'offline';

  return null;
}

async function officialBlizzardSignal(profile, options) {
  try {
    const tracker = await fetchJson(profile.forum.trackerUrl, options);
    const posts = trackerPosts(tracker)
      .filter((post) => post?.topic_id && post?.created_at)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    const recent = posts
      .filter((post) =>
        ageMs(post.created_at, options.nowMs) <=
        profile.thresholds.officialContextMaxAgeMs)
      .slice(0, 15);

    for (const post of recent) {
      let topic;
      try {
        topic = await fetchJson(
          `\${profile.forum.baseUrl}/t/\${post.topic_id}.json`,
          options,
        );
      } catch {
        continue;
      }
      if (Number(topic?.category_id) !== profile.forum.categoryId) continue;

      const text = [topic?.title, post?.cooked, post?.excerpt].filter(Boolean).join(' ');
      const signal = classifyOfficialText(profile, htmlToText(text));
      if (!signal) continue;

      return {
        signal,
        created_at: post.created_at,
        age_ms: ageMs(post.created_at, options.nowMs),
        topic_id: post.topic_id,
        post_number: post.post_number || 1,
        title: topic?.title || 'Blizzard post',
        url:
          `\${profile.forum.baseUrl}/t/\${topic?.slug || post?.slug || 'topic'}/` +
          `\${post.topic_id}/\${post.post_number || 1}`,
        error: null,
      };
    }

    return {
      signal: null, created_at: null, age_ms: null, topic_id: null,
      post_number: null, title: null, url: null, error: null,
    };
  } catch (error) {
    return {
      signal: null, created_at: null, age_ms: null, topic_id: null,
      post_number: null, title: null, url: null,
      error: String(error?.message || error),
    };
  }
}

async function robustTcpProbe(target, tcpConnect) {
  const attempts = [];
  if (!target || !tcpConnect) {
    return { up: false, latency: null, attempts, unavailable: true };
  }

  for (let i = 0; i < 3; i += 1) {
    attempts.push(await tcpConnect(target.host, target.port, 3500));
    if (attempts.at(-1).up) break;
    if (i < 2) await sleep(400);
  }

  const success = attempts.find((attempt) => attempt.up);
  return {
    up: Boolean(success),
    latency: success?.latency ?? null,
    attempts,
    unavailable: false,
  };
}

export async function collectEvidence(
  profile,
  { tcpConnect, fetchImpl = fetch, runtimeLabel = 'unknown-runtime', nowMs = Date.now() } = {},
) {
  const options = {
    fetchImpl,
    nowMs,
    userAgent: `ForeverRealmStatus/3.0 (\${runtimeLabel})`,
  };

  const [loginTcp, realmTcp, foreverDb, official] = await Promise.all([
    robustTcpProbe(profile.direct?.login, tcpConnect),
    robustTcpProbe(profile.direct?.realm, tcpConnect),
    foreverDbProbe(profile, options),
    officialBlizzardSignal(profile, options),
  ]);

  return { loginTcp, realmTcp, foreverDb, official };
}
