import assert from 'node:assert/strict';
import test from 'node:test';

import { sendDiscord } from './discord.mjs';

test('realm alert pings only the configured tools role', async () => {
  let payload;
  const fetchImpl = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true };
  };

  await sendDiscord({
    webhookUrl: 'https://discord.test/webhook',
    kind: 'transition',
    profile: { id: 'live', displayName: 'WoW Forever' },
    observed: {
      status: 'online',
      confidence: 'high',
      reason: 'Realm evidence is healthy.',
    },
    previous: {
      status: 'prelaunch',
      confirmed_status: 'prelaunch',
    },
    diagnostics: {
      foreverDb: {
        login: true,
        realm: true,
        login_fresh: true,
        realm_fresh: true,
        login_checked_at: '2026-10-26T05:00:00.000Z',
        realm_checked_at: '2026-10-26T05:00:00.000Z',
      },
      loginTcp: { up: true, latency: 25 },
      realmTcp: { up: true, latency: 30 },
      official: { signal: null },
    },
    runtimeLabel: 'test',
    mentionRoleId: '123456789012345678',
    fetchImpl,
  });

  assert.equal(payload.content, '<@&123456789012345678>');
  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    roles: ['123456789012345678'],
  });
});
