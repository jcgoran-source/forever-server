import net from 'node:net';

const LOGIN_HOST = 'test.actual.battle.net';
const LOGIN_PORT = 1119;
const REALM_HOST = '66.40.176.157';
const REALM_PORT = 3724;

const FOREVERDB_URL = 'https://foreverdb.net/status';
const BLIZZARD_TRACKER_URL =
  'https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json';
const FORUM_BASE = 'https://us.forums.blizzard.com/en/wow';
const FOREVER_CATEGORY_ID = 349;

const STATE_ISSUE_NUMBER = Number(process.env.STATE_ISSUE_NUMBER || '1');
const FOREVERDB_MAX_AGE_MS = 10 * 60 * 1000;
const OFFICIAL_SIGNAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HEALTH_HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_CONFIRMATIONS = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ageMs(iso) {
  const value = Date.parse(iso || '');
  return Number.isFinite(value) ? Date.now() - value : Infinity;
}

function tcpProbe(host, port, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (up, error = null) => {
      if (settled) return;
      settled = true;
      const latency = Date.now() - started;
      socket.destroy();
      resolve({
        up,
        latency: up ? latency : null,
        error: error ? String(error.code || error.message || error) : null,
      });
    };

    socket.setTimeout(timeoutMs, () => finish(false, new Error('timeout')));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(false, error));
  });
}

async function robustTcpProbe(host, port) {
  const attempts = [];

  for (let i = 0; i < 3; i += 1) {
    attempts.push(await tcpProbe(host, port));
    if (attempts.at(-1).up) break;
    if (i < 2) await sleep(400);
  }

  const success = attempts.find((attempt) => attempt.up);
  return {
    up: Boolean(success),
    latency: success?.latency ?? null,
    attempts,
  };
}

function decodeEntities(text = '') {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
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

function htmlToText(html = '') {
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

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': 'ForeverRealmStatus/2.0 (+GitHub Actions)',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.headers || {}),
    },
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

async function foreverDbProbe() {
  try {
    const separator = FOREVERDB_URL.includes('?') ? '&' : '?';
    const html = await fetchText(
      `${FOREVERDB_URL}${separator}_=${Date.now()}`,
      { headers: { accept: 'text/html' } },
    );
    const text = htmlToText(html);

    const statusPattern =
      '(Not answering|Answering|Offline|Online|Down|Up)';

    const loginMatch = text.match(
      new RegExp(
        `Beta login server\\s+${statusPattern}[\\s\\S]{0,220}?checked\\s+([0-9T:.+-]+Z?)`,
        'i',
      ),
    );

    const realmMatch = text.match(
      new RegExp(
        `Realm game servers\\s+${statusPattern}[\\s\\S]{0,220}?checked\\s+([0-9T:.+-]+Z?)`,
        'i',
      ),
    );

    const maintenanceMatch = text.match(
      /Maintenance now:\s*(.{0,400}?)(?:Beta login server|$)/i,
    );

    const loginCheckedAt = parseCheckedAt(loginMatch);
    const realmCheckedAt = parseCheckedAt(realmMatch);
    const login = parseServiceStatus(loginMatch);
    const realm = parseServiceStatus(realmMatch);

    const loginFresh =
      login !== null &&
      loginCheckedAt !== null &&
      ageMs(loginCheckedAt) <= FOREVERDB_MAX_AGE_MS;

    const realmFresh =
      realm !== null &&
      realmCheckedAt !== null &&
      ageMs(realmCheckedAt) <= FOREVERDB_MAX_AGE_MS;

    const parseProblems = [];
    if (login === null) parseProblems.push('login status missing');
    if (realm === null) parseProblems.push('realm status missing');
    if (!loginCheckedAt) parseProblems.push('login timestamp missing');
    if (!realmCheckedAt) parseProblems.push('realm timestamp missing');
    if (loginCheckedAt && !loginFresh) parseProblems.push('login result stale');
    if (realmCheckedAt && !realmFresh) parseProblems.push('realm result stale');

    return {
      login,
      realm,
      login_checked_at: loginCheckedAt,
      realm_checked_at: realmCheckedAt,
      login_fresh: loginFresh,
      realm_fresh: realmFresh,
      maintenance: maintenanceMatch?.[1]?.trim() || null,
      error: parseProblems.length ? parseProblems.join('; ') : null,
    };
  } catch (error) {
    return {
      login: null,
      realm: null,
      login_checked_at: null,
      realm_checked_at: null,
      login_fresh: false,
      realm_fresh: false,
      maintenance: null,
      error: String(error?.message || error),
    };
  }
}

function trackerPosts(data) {
  const direct =
    data?.latest_posts ||
    data?.post_stream?.posts ||
    data?.posts;

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
      })
      .filter((post) => post?.id && post?.topic_id);
  }

  return [];
}

function classifyOfficialText(text) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();

  if (
    /coming back online imminently|back online imminently|re-?open(?:ing)? shortly|back shortly/i.test(
      normalized,
    )
  ) {
    return 'transition';
  }

  if (
    /\b(beta|realm(?:s)?)\b.{0,100}\b(is back|are back|back online|back up|is up|are up|re-?opened|online now)\b/i.test(
      normalized,
    ) ||
    /\b(back online|back up|re-?opened)\b.{0,100}\b(beta|realm(?:s)?)\b/i.test(
      normalized,
    )
  ) {
    return 'online';
  }

  if (
    /\b(take|taking|took|bring|bringing)\b.{0,100}\b(beta|realm(?:s)?)\b.{0,80}\b(offline|down)\b/i.test(
      normalized,
    ) ||
    /\b(beta|realm(?:s)?)\b.{0,100}\b(offline|down|shut ?down)\b/i.test(
      normalized,
    )
  ) {
    return 'offline';
  }

  return null;
}

async function officialBlizzardSignal() {
  try {
    const tracker = await fetchJson(BLIZZARD_TRACKER_URL);
    const posts = trackerPosts(tracker)
      .filter((post) => post?.topic_id && post?.created_at)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    const recent = posts
      .filter((post) => ageMs(post.created_at) <= OFFICIAL_SIGNAL_MAX_AGE_MS)
      .slice(0, 15);

    for (const post of recent) {
      let topic;

      try {
        topic = await fetchJson(`${FORUM_BASE}/t/${post.topic_id}.json`);
      } catch {
        continue;
      }

      if (Number(topic?.category_id) !== FOREVER_CATEGORY_ID) continue;

      const text = [
        topic?.title,
        post?.cooked,
        post?.excerpt,
      ].filter(Boolean).join(' ');

      const signal = classifyOfficialText(htmlToText(text));
      if (!signal) continue;

      return {
        signal,
        created_at: post.created_at,
        age_ms: ageMs(post.created_at),
        topic_id: post.topic_id,
        post_number: post.post_number || 1,
        title: topic?.title || 'Blizzard post',
        url: `${FORUM_BASE}/t/${topic?.slug || post?.slug || 'topic'}/${post.topic_id}/${post.post_number || 1}`,
        error: null,
      };
    }

    return {
      signal: null,
      created_at: null,
      age_ms: null,
      topic_id: null,
      post_number: null,
      title: null,
      url: null,
      error: null,
    };
  } catch (error) {
    return {
      signal: null,
      created_at: null,
      age_ms: null,
      topic_id: null,
      post_number: null,
      title: null,
      url: null,
      error: String(error?.message || error),
    };
  }
}

function foreverDbState(source) {
  if (!source.login_fresh || !source.realm_fresh) return 'unknown';
  if (source.realm === false) return 'offline';
  if (source.realm === true && source.login === false) return 'degraded';
  if (source.realm === true && source.login === true) return 'online';
  return 'unknown';
}

function resolveStatus({ foreverDb, loginTcp, realmTcp, official }) {
  const dbState = foreverDbState(foreverDb);
  const directOnline = loginTcp.up && realmTcp.up;
  const officialState =
    official.signal === 'online' || official.signal === 'offline'
      ? official.signal
      : null;

  const evidence = {
    foreverdb: dbState,
    direct_login: loginTcp.up ? 'positive' : 'inconclusive',
    direct_realm: realmTcp.up ? 'positive' : 'inconclusive',
    official: official.signal || 'none',
  };

  if (dbState === 'online') {
    if (officialState === 'offline') {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'ForeverDB says online while a recent Blizzard post says offline.',
        evidence,
      };
    }

    return {
      status: 'online',
      confidence: directOnline || officialState === 'online' ? 'high' : 'medium',
      reason:
        directOnline || officialState === 'online'
          ? 'Fresh ForeverDB status is corroborated.'
          : 'Fresh ForeverDB status says both login and realm services are answering.',
      evidence,
    };
  }

  if (dbState === 'offline') {
    if (realmTcp.up || officialState === 'online') {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'A fresh offline reading conflicts with positive evidence.',
        evidence,
      };
    }

    return {
      status: 'offline',
      confidence: officialState === 'offline' ? 'high' : 'medium',
      reason:
        officialState === 'offline'
          ? 'Fresh ForeverDB outage is corroborated by Blizzard.'
          : 'Fresh ForeverDB status says the realm game service is not answering.',
      evidence,
    };
  }

  if (dbState === 'degraded') {
    if (directOnline) {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'ForeverDB reports degraded service while both direct probes answer.',
        evidence,
      };
    }

    return {
      status: 'degraded',
      confidence: 'medium',
      reason: 'Fresh ForeverDB status says the realm answers but the login service does not.',
      evidence,
    };
  }

  // Without a fresh aggregate sensor, failed hosted-runner probes are not
  // negative evidence. Only positive TCP connections may be used as fallback.
  if (directOnline) {
    if (officialState === 'offline') {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'Direct probes answer while a recent Blizzard post says offline.',
        evidence,
      };
    }

    return {
      status: 'online',
      confidence: 'medium',
      reason: 'Both direct service probes answer; aggregate sensor is unavailable or stale.',
      evidence,
    };
  }

  if (officialState === 'offline') {
    return {
      status: 'offline',
      confidence: 'medium',
      reason: 'Blizzard recently said the Beta/realms are offline; aggregate sensor is unavailable.',
      evidence,
    };
  }

  if (officialState === 'online' && (loginTcp.up || realmTcp.up)) {
    return {
      status: 'online',
      confidence: 'medium',
      reason: 'Blizzard recently said the Beta/realms are online and a direct service probe answers.',
      evidence,
    };
  }

  return {
    status: 'unknown',
    confidence: 'insufficient',
    reason: 'Available sources are stale, unavailable, or insufficient to establish realm state.',
    evidence,
  };
}

function extractState(body = '') {
  const match = String(body).match(/```json\s*([\s\S]*?)```/i);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function normalizeState(state) {
  const previous = state && typeof state === 'object' ? state : {};
  const known =
    ['online', 'offline', 'degraded'].includes(previous.status)
      ? previous.status
      : previous.confirmed_status;

  return {
    version: 2,
    status: previous.status || 'unknown',
    confirmed_status: previous.confirmed_status || known || 'unknown',
    updated_at: previous.updated_at || null,
    last_health_at: previous.last_health_at || null,
    unknown_streak: Number(previous.unknown_streak || 0),
  };
}

function stateBody(state) {
  return [
    'Managed automatically by `services/beta-realm-status/check.mjs`. Please do not edit.',
    '',
    '```json',
    JSON.stringify(state),
    '```',
  ].join('\n');
}

async function githubRequest(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;

  if (!token || !repository) {
    throw new Error('GitHub runtime variables are missing');
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}${path}`,
    {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ForeverRealmStatus/2.0 (+GitHub Actions)',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub ${path} -> HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getPreviousState() {
  const issue = await githubRequest(`/issues/${STATE_ISSUE_NUMBER}`);
  return normalizeState(extractState(issue.body));
}

async function saveState(state) {
  await githubRequest(`/issues/${STATE_ISSUE_NUMBER}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: stateBody(state) }),
  });
}

function statusLabel(value) {
  if (value === 'online') return 'ONLINE';
  if (value === 'offline') return 'OFFLINE';
  if (value === 'degraded') return 'DEGRADED';
  return 'UNKNOWN';
}

function sourceSummary(diagnostics) {
  const db = foreverDbState(diagnostics.foreverDb);
  const dbFresh =
    diagnostics.foreverDb.login_fresh && diagnostics.foreverDb.realm_fresh;

  const dbText = dbFresh
    ? `${statusLabel(db)} · login checked ${diagnostics.foreverDb.login_checked_at} · realm checked ${diagnostics.foreverDb.realm_checked_at}`
    : `UNKNOWN · ${diagnostics.foreverDb.error || 'stale/unparseable'}`;

  const directText = [
    `login ${diagnostics.loginTcp.up ? `answering (${diagnostics.loginTcp.latency} ms)` : 'inconclusive'}`,
    `realm ${diagnostics.realmTcp.up ? `answering (${diagnostics.realmTcp.latency} ms)` : 'inconclusive'}`,
  ].join(' · ');

  const officialText = diagnostics.official.signal
    ? `${diagnostics.official.signal.toUpperCase()} · ${diagnostics.official.title}`
    : diagnostics.official.error
      ? `unavailable · ${diagnostics.official.error}`
      : 'no recent explicit state signal';

  return { dbText, directText, officialText };
}

async function sendDiscord(kind, observed, previous, diagnostics) {
  const webhookUrl =
    process.env.DISCORD_REALM_STATUS_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error('No Discord webhook secret is configured');
  }

  const styles = {
    online: ['🟢 Forever Beta is ONLINE', 0x57f287],
    offline: ['🔴 Forever Beta is OFFLINE', 0xed4245],
    degraded: ['🟡 Forever Beta is DEGRADED', 0xfee75c],
    unknown: ['⚪ Forever Beta status is UNKNOWN', 0x99aab5],
  };

  let [title, color] =
    styles[observed.status] || styles.unknown;

  let description = observed.reason;

  if (kind === 'heartbeat') {
    title = `💓 Realm sentry healthy · ${statusLabel(observed.status)}`;
    color = styles[observed.status]?.[1] || 0x99aab5;
    description =
      'The sentry is healthy and its evidence sources produced a usable status.';
  } else if (observed.status === 'unknown') {
    description =
      `${observed.reason} No outage is being asserted. Last confirmed state: ${statusLabel(previous.confirmed_status)}.`;
  }

  const summary = sourceSummary(diagnostics);
  const fields = [
    {
      name: 'Confidence',
      value: observed.confidence,
      inline: true,
    },
    {
      name: 'ForeverDB',
      value: summary.dbText.slice(0, 1024),
      inline: false,
    },
    {
      name: 'Direct probes',
      value: summary.directText.slice(0, 1024),
      inline: false,
    },
    {
      name: 'Recent Blizzard signal',
      value: summary.officialText.slice(0, 1024),
      inline: false,
    },
  ];

  const payload = {
    username: 'Forever Realm Sentry',
    allowed_mentions: { parse: [] },
    embeds: [{
      title,
      description: description.slice(0, 4096),
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text:
          kind === 'heartbeat'
            ? '24-hour health heartbeat'
            : `Previous announced state: ${statusLabel(previous.status)}`,
      },
    }],
  };

  const separator = webhookUrl.includes('?') ? '&' : '?';
  const response = await fetch(`${webhookUrl}${separator}wait=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverRealmStatus/2.0 (+GitHub Actions)',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Discord send -> HTTP ${response.status}`);
  }
}

async function main() {
  const [loginTcp, realmTcp, foreverDb, official, previousRaw] =
    await Promise.all([
      robustTcpProbe(LOGIN_HOST, LOGIN_PORT),
      robustTcpProbe(REALM_HOST, REALM_PORT),
      foreverDbProbe(),
      officialBlizzardSignal(),
      getPreviousState(),
    ]);

  const previous = normalizeState(previousRaw);
  const observed = resolveStatus({
    foreverDb,
    loginTcp,
    realmTcp,
    official,
  });

  const diagnostics = {
    foreverDb,
    loginTcp,
    realmTcp,
    official,
  };

  console.log(
    JSON.stringify(
      {
        observed,
        sources: diagnostics,
        previous,
      },
      null,
      2,
    ),
  );

  const now = new Date().toISOString();
  const migratingToV2 =
    !previousRaw?.version || Number(previousRaw.version) < 2;

  if (observed.status === 'unknown') {
    const nextStreak = previous.unknown_streak + 1;
    const next = {
      ...previous,
      version: 2,
      unknown_streak: nextStreak,
      last_health_at:
        previous.last_health_at || (migratingToV2 ? now : null),
    };

    if (nextStreak >= UNKNOWN_CONFIRMATIONS && previous.status !== 'unknown') {
      await sendDiscord('transition', observed, previous, diagnostics);
      next.status = 'unknown';
      next.updated_at = now;
      console.warn(
        `::warning::Realm status became UNKNOWN after ${nextStreak} consecutive inconclusive checks.`,
      );
    } else {
      console.warn(
        `::warning::Realm status inconclusive (${nextStreak}/${UNKNOWN_CONFIRMATIONS}); no outage asserted.`,
      );
    }

    await saveState(next);
    return;
  }

  const next = {
    ...previous,
    version: 2,
    status: observed.status,
    confirmed_status: observed.status,
    unknown_streak: 0,
    updated_at:
      previous.status === observed.status && previous.updated_at
        ? previous.updated_at
        : now,
    last_health_at:
      previous.last_health_at || (migratingToV2 ? now : null),
  };

  if (previous.status !== observed.status) {
    await sendDiscord('transition', observed, previous, diagnostics);
    await saveState(next);
    console.log(
      `Realm-status transition sent: ${previous.status} -> ${observed.status} (${observed.confidence}).`,
    );
    return;
  }

  const heartbeatDue =
    next.last_health_at &&
    ageMs(next.last_health_at) >= HEALTH_HEARTBEAT_MS;

  if (heartbeatDue) {
    await sendDiscord('heartbeat', observed, previous, diagnostics);
    next.last_health_at = now;
    await saveState(next);
    console.log(
      `Realm sentry health heartbeat sent: ${observed.status} (${observed.confidence}).`,
    );
    return;
  }

  if (migratingToV2 || previous.unknown_streak !== 0) {
    await saveState(next);
  }

  console.log(
    `No realm-status transition: still ${observed.status} (${observed.confidence}).`,
  );
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
