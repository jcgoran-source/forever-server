import assert from 'node:assert/strict';
import test from 'node:test';

import { getProfile } from './profiles.mjs';
import { parseForeverDbStatusText } from './sensors.mjs';

const live = getProfile('live');

const currentPrelaunchText = `
WoW Forever server status
The WoW Forever beta has ended, and the live servers open on 4 November 2026.
Until then we check Blizzard's login servers for the live game.
Americas login server: Answering
Europe login server: Answering
Korea login server: Answering
`;

test('parses current ForeverDB prelaunch login status', () => {
  const nowMs = Date.parse('2026-10-25T19:30:00-07:00');
  const parsed = parseForeverDbStatusText(live, currentPrelaunchText, nowMs);

  assert.equal(parsed.phase, 'prelaunch');
  assert.equal(parsed.login, true);
  assert.equal(parsed.login_fresh, true);
  assert.equal(parsed.realm, null);
  assert.equal(parsed.realm_fresh, false);
  assert.equal(parsed.error, null);
});

test('missing realm status becomes an error after launch', () => {
  const nowMs = Date.parse('2026-11-04T23:01:00Z');
  const parsed = parseForeverDbStatusText(live, currentPrelaunchText, nowMs);

  assert.equal(parsed.phase, 'live');
  assert.match(parsed.error, /realm status missing/);
});

test('parses live realm status when ForeverDB begins publishing it', () => {
  const text = `
    Americas login server: Answering
    Realm game servers: Answering
  `;
  const nowMs = Date.parse('2026-11-04T23:01:00Z');
  const parsed = parseForeverDbStatusText(live, text, nowMs);

  assert.equal(parsed.phase, 'live');
  assert.equal(parsed.login, true);
  assert.equal(parsed.realm, true);
  assert.equal(parsed.login_fresh, true);
  assert.equal(parsed.realm_fresh, true);
  assert.equal(parsed.error, null);
});
