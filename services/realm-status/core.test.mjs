import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateObservation, resolveStatus } from './core.mjs';
import { getProfile } from './profiles.mjs';

const profile = getProfile('beta');

function diagnostics({
  db = 'online', login = false, realm = false,
  official = null, officialAge = null,
} = {}) {
  const dbMap = {
    online: { login: true, realm: true },
    offline: { login: true, realm: false },
    degraded: { login: false, realm: true },
    unknown: { login: null, realm: null },
  };
  const chosen = dbMap[db];
  return {
    foreverDb: {
      login: chosen.login,
      realm: chosen.realm,
      login_fresh: db !== 'unknown',
      realm_fresh: db !== 'unknown',
    },
    loginTcp: { up: login },
    realmTcp: { up: realm },
    official: { signal: official, age_ms: officialAge },
  };
}

test('fresh aggregate online survives failed direct realm probe', () => {
  const result = resolveStatus(
    profile,
    diagnostics({ db: 'online', login: true, realm: false }),
  );
  assert.equal(result.status, 'online');
});

test('fresh aggregate outage is accepted without conflicting positive evidence', () => {
  assert.equal(resolveStatus(profile, diagnostics({ db: 'offline' })).status, 'offline');
});

test('fresh aggregate outage plus positive realm probe becomes unknown', () => {
  const result = resolveStatus(profile, diagnostics({ db: 'offline', realm: true }));
  assert.equal(result.status, 'unknown');
  assert.equal(result.confidence, 'conflict');
});

test('stale aggregate plus failed direct probes does not fabricate outage', () => {
  assert.equal(resolveStatus(profile, diagnostics({ db: 'unknown' })).status, 'unknown');
});

test('stale aggregate plus two positive direct probes establishes online', () => {
  assert.equal(
    resolveStatus(profile, diagnostics({ db: 'unknown', login: true, realm: true })).status,
    'online',
  );
});

test('old official outage is context-only', () => {
  const result = resolveStatus(
    profile,
    diagnostics({
      db: 'online',
      official: 'offline',
      officialAge: profile.thresholds.officialVoteMaxAgeMs + 1,
    }),
  );
  assert.equal(result.status, 'online');
});

test('first known observation bootstraps silently', () => {
  const decision = evaluateObservation(
    profile,
    {},
    { status: 'online', confidence: 'medium' },
    '2026-10-21T16:00:00.000Z',
  );
  assert.equal(decision.bootstrap, true);
  assert.equal(decision.action, null);
  assert.equal(decision.next.status, 'online');
});

test('unknown requires two consecutive observations before announcement', () => {
  const prior = {
    version: 3,
    profile: 'beta',
    status: 'online',
    confirmed_status: 'online',
    updated_at: '2026-10-21T15:00:00.000Z',
    last_health_at: '2026-10-21T15:00:00.000Z',
    unknown_streak: 0,
  };
  const observed = { status: 'unknown', confidence: 'insufficient' };

  const first = evaluateObservation(
    profile, prior, observed, '2026-10-21T16:00:00.000Z',
  );
  assert.equal(first.action, null);
  assert.equal(first.next.status, 'online');
  assert.equal(first.next.unknown_streak, 1);

  const second = evaluateObservation(
    profile, first.next, observed, '2026-10-21T16:01:00.000Z',
  );
  assert.equal(second.action, 'transition');
  assert.equal(second.next.status, 'unknown');
  assert.equal(second.next.confirmed_status, 'online');
});
