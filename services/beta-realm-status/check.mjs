import net from 'node:net';

const LOGIN_HOST = 'test.actual.battle.net';
const LOGIN_PORT = 1119;
const REALM_HOST = '66.40.176.157';
const REALM_PORT = 3724;
const FOREVERDB_URL = 'https://foreverdb.net/status';
const STATE_ISSUE_NUMBER = Number(process.env.STATE_ISSUE_NUMBER || '1');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      resolve({ up, latency, error: error ? String(error.code || error.message || error) : null });
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
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

async function foreverDbProbe() {
  try {
    const response = await fetch(FOREVERDB_URL, {
      headers: {
        accept: 'text/html',
        'user-agent': 'ForeverRealmStatus/1.1 (+GitHub Actions)',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { login: null, realm: null, error: `HTTP ${response.status}` };
    }

    const text = htmlToText(await response.text());
    const loginMatch = text.match(
      /Beta login server\s+(Not answering|Answering|Offline|Online|Down|Up)\b/i,
    );
    const realmMatch = text.match(
      /Realm game servers\s+(Not answering|Answering|Offline|Online|Down|Up)\b/i,
    );
    const plannedMatch = text.match(/Maintenance planned:\s*(.{0,280}?)(?:Beta login server|##|$)/i);

    const statusValue = (match) => {
      if (!match) return null;
      const value = match[1].toLowerCase();
      if (value === 'answering' || value === 'up' || value === 'online') return true;
      if (value === 'not answering' || value === 'down' || value === 'offline') return false;
      return null;
    };

    return {
      login: statusValue(loginMatch),
      realm: statusValue(realmMatch),
      maintenance: plannedMatch?.[1]?.trim() || null,
      error: null,
    };
  } catch (error) {
    return {
      login: null,
      realm: null,
      maintenance: null,
      error: String(error?.message || error),
    };
  }
}

function summarizeState({ login, realm }) {
  if (realm === false) return 'offline';
  if (realm === true && login === false) return 'degraded';
  if (realm === true && login === true) return 'online';
  return 'unknown';
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
  if (!token || !repository) throw new Error('GitHub runtime variables are missing');

  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ForeverRealmStatus/1.1 (+GitHub Actions)',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${path} -> HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getPreviousState() {
  const issue = await githubRequest(`/issues/${STATE_ISSUE_NUMBER}`);
  return extractState(issue.body) || {
    version: 1,
    status: 'unknown',
    login: 'unknown',
    realm: 'unknown',
    updated_at: null,
  };
}

async function saveState(state) {
  await githubRequest(`/issues/${STATE_ISSUE_NUMBER}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: stateBody(state) }),
  });
}

async function sendDiscord(state, previous, diagnostics) {
  const webhookUrl =
    process.env.DISCORD_REALM_STATUS_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) throw new Error('No Discord webhook secret is configured');

  const labels = {
    online: ['🟢 Forever Beta is ONLINE', 0x57f287],
    offline: ['🔴 Forever Beta is OFFLINE', 0xed4245],
    degraded: ['🟡 Forever Beta is DEGRADED', 0xfee75c],
  };

  const [title, color] = labels[state.status] || ['⚪ Forever Beta status changed', 0x99aab5];
  const loginText = state.login === 'up' ? 'Up' : state.login === 'down' ? 'Down' : 'Unknown';
  const realmText = state.realm === 'up' ? 'Up' : state.realm === 'down' ? 'Down' : 'Unknown';

  let description;
  if (state.status === 'online') {
    description = 'The Forever Beta realm service is answering again.';
  } else if (state.status === 'offline') {
    description = 'The Forever Beta realm game service is not answering.';
  } else {
    description = 'The realm service is answering, but the login service is not fully available.';
  }

  const fields = [
    { name: 'Login service', value: loginText, inline: true },
    { name: 'Realm service', value: realmText, inline: true },
  ];

  if (diagnostics.loginTcp.latency != null) {
    fields.push({ name: 'Login probe', value: `${diagnostics.loginTcp.latency} ms`, inline: true });
  }
  if (diagnostics.realmTcp.latency != null) {
    fields.push({ name: 'Realm probe', value: `${diagnostics.realmTcp.latency} ms`, inline: true });
  }

  const payload = {
    username: 'Forever Realm Sentry',
    allowed_mentions: { parse: [] },
    embeds: [{
      title,
      description,
      color,
      fields,
      timestamp: state.updated_at,
      footer: {
        text: `Previous: ${previous.status} • checked every 5 minutes`,
      },
    }],
  };

  const sep = webhookUrl.includes('?') ? '&' : '?';
  const response = await fetch(`${webhookUrl}${sep}wait=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverRealmStatus/1.1 (+GitHub Actions)',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Discord send -> HTTP ${response.status}`);
  }
}

async function main() {
  const [loginTcp, realmTcp, foreverDb, previous] = await Promise.all([
    robustTcpProbe(LOGIN_HOST, LOGIN_PORT),
    robustTcpProbe(REALM_HOST, REALM_PORT),
    foreverDbProbe(),
    getPreviousState(),
  ]);

  // ForeverDB checks all four beta game servers, so prefer its aggregate realm
  // result when available. Direct TCP probes are an independent fallback/sanity check.
  const loginUp = foreverDb.login ?? loginTcp.up;
  const realmUp = foreverDb.realm ?? realmTcp.up;

  const observed = {
    version: 1,
    status: summarizeState({ login: loginUp, realm: realmUp }),
    login: loginUp === true ? 'up' : loginUp === false ? 'down' : 'unknown',
    realm: realmUp === true ? 'up' : realmUp === false ? 'down' : 'unknown',
    updated_at: new Date().toISOString(),
  };

  console.log(JSON.stringify({
    observed,
    direct: {
      login: { up: loginTcp.up, latency: loginTcp.latency, attempts: loginTcp.attempts.length },
      realm: { up: realmTcp.up, latency: realmTcp.latency, attempts: realmTcp.attempts.length },
    },
    foreverDb,
    previous,
  }, null, 2));

  if (observed.status === 'unknown') {
    throw new Error('Unable to determine Forever Beta service state from either source');
  }

  // First invocation establishes the baseline silently.
  if (!previous || previous.status === 'unknown') {
    await saveState(observed);
    console.log(`Bootstrapped realm sentry at ${observed.status}; no Discord notification sent.`);
    return;
  }

  if (observed.status === previous.status) {
    console.log(`No realm-status transition: still ${observed.status}.`);
    return;
  }

  await sendDiscord(observed, previous, { loginTcp, realmTcp, foreverDb });
  await saveState(observed);
  console.log(`Realm-status transition sent: ${previous.status} -> ${observed.status}.`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
