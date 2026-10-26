import assert from 'node:assert/strict';
import test from 'node:test';

import { selectHistoricalCandidates } from './backfill.mjs';

function post(overrides = {}) {
  return {
    id: 1,
    topic_id: 10,
    category_id: 347,
    created_at: '2026-10-21T12:00:00.000Z',
    topic_title: 'World of Warcraft: Forever Update',
    cooked: '<p>Forever update body.</p>',
    ...overrides,
  };
}

test('historical selection respects the date window', () => {
  const selected = selectHistoricalCandidates([
    post({ id: 1, created_at: '2026-10-19T23:59:59.000Z' }),
    post({ id: 2, created_at: '2026-10-20T00:00:00.000Z' }),
    post({ id: 3, created_at: '2026-10-25T20:00:00.000Z' }),
  ], {
    sinceMs: Date.parse('2026-10-20T00:00:00.000Z'),
    untilMs: Date.parse('2026-10-25T19:00:00.000Z'),
    limit: 12,
  });

  assert.deepEqual(selected.map((item) => item.id), [2]);
});

test('historical selection suppresses mirrored identical announcements', () => {
  const selected = selectHistoricalCandidates([
    post({
      id: 10,
      topic_id: 100,
      topic_title: 'World of Warcraft: Forever Raid Overview',
      cooked: '<p>Barrow Deeps opens December 9.</p>',
    }),
    post({
      id: 11,
      topic_id: 101,
      topic_title: 'World of Warcraft: Forever Raid Overview',
      cooked: '<p>Barrow Deeps opens December 9.</p>',
    }),
  ], {
    sinceMs: Date.parse('2026-10-20T00:00:00.000Z'),
    untilMs: Date.parse('2026-10-26T00:00:00.000Z'),
    limit: 12,
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 10);
});

test('historical selection enforces its cap on the newest unique items', () => {
  const posts = Array.from({ length: 15 }, (_, index) => post({
    id: index + 1,
    topic_id: index + 100,
    created_at: new Date(
      Date.parse('2026-10-20T00:00:00.000Z') + index * 60_000,
    ).toISOString(),
    topic_title: `WoW Forever update ${index + 1}`,
    cooked: `<p>Unique Forever change ${index + 1}.</p>`,
  }));

  const selected = selectHistoricalCandidates(posts, {
    sinceMs: Date.parse('2026-10-20T00:00:00.000Z'),
    untilMs: Date.parse('2026-10-21T00:00:00.000Z'),
    limit: 12,
  });

  assert.equal(selected.length, 12);
  assert.deepEqual(selected.map((item) => item.id), [4,5,6,7,8,9,10,11,12,13,14,15]);
});
