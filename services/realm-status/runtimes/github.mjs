import net from 'node:net';

import { getProfile } from '../profiles.mjs';
import { executeSentry } from '../sentry.mjs';

const STATE_ISSUE_NUMBER = Number(process.env.STATE_ISSUE_NUMBER || '1');

function nodeTcpConnect(host, port, timeoutMs = 3500) {
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

function extractState(body = '') {
  const match = String(body).match(/```json\s*([\s\S]*?)```/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function stateBody(state) {
  return [
    'Managed automatically by `services/realm-status/runtimes/github.mjs`. Please do not edit.',
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

  const response = await fetch(
    `https://api.github.com/repos/${repository}${path}`,
    {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ForeverRealmStatus/3.0 (github-actions)',
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

const stateStore = {
  async get() {
    const issue = await githubRequest(`/issues/${STATE_ISSUE_NUMBER}`);
    return extractState(issue.body) || {};
  },
  async put(state) {
    await githubRequest(`/issues/${STATE_ISSUE_NUMBER}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: stateBody(state) }),
    });
  },
};

async function main() {
  const profile = getProfile(process.env.FOREVER_ENV || 'beta');
  const webhookUrl =
    process.env.DISCORD_REALM_STATUS_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) throw new Error('No Discord webhook secret is configured');

  await executeSentry({
    profile,
    stateStore,
    tcpConnect: nodeTcpConnect,
    webhookUrl,
    mentionRoleId: process.env.FOREVER_TOOLS_ROLE_ID,
    runtimeLabel: 'github-actions',
  });
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
