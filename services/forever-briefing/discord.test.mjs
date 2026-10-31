import assert from 'node:assert/strict';
import test from 'node:test';

import { briefingPayload } from './discord.mjs';

const briefing = {
  sequence: 2,
  kind: 'current',
  generated_at: '2026-10-26T05:00:00.000Z',
  change_count: 1,
  groups: [{
    category: 'General',
    items: [{
      priority: 'normal',
      title: 'Test update',
      url: 'https://example.com/update',
      summary: 'Test summary.',
    }],
  }],
};

test('briefing payload pings only the configured tools role', () => {
  const payload = briefingPayload(briefing, '123456789012345678');
  assert.equal(payload.content, '<@&123456789012345678>');
  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    roles: ['123456789012345678'],
  });
});

test('briefing payload suppresses mentions when no valid role is configured', () => {
  const payload = briefingPayload(briefing, 'not-a-role');
  assert.equal(payload.content, undefined);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('current briefing is titled Forever news briefing', () => {
  const current = briefingPayload(briefing);
  assert.equal(current.embeds[0].title, 'Forever news briefing · #2');
  const historical = briefingPayload({ ...briefing, kind: 'historical' });
  assert.equal(historical.embeds[0].title, 'Forever historical briefing · #2');
});
