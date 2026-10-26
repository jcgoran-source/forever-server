import assert from 'node:assert/strict';
import test from 'node:test';

import {
  briefingDue,
  buildBriefing,
  ingestPostIntoState,
  markBriefingSent,
  synthesizePost,
} from './synthesizer.mjs';

function post(overrides = {}) {
  return {
    id: 31000001,
    topic_id: 2400000,
    post_number: 1,
    category_id: 347,
    username: 'Kaivax',
    name: 'Kaivax',
    created_at: '2026-10-26T12:00:00.000Z',
    topic_title: 'Testing changes to Frost Mage in WoW Forever',
    cooked: '<p>Frostbolt damage has been adjusted for launch testing.</p>',
    slug: 'testing-changes-to-frost-mage',
    ...overrides,
  };
}

test('classifies a Frost Mage change and marks launch-plan relevance high', () => {
  const change = synthesizePost(post());
  assert.ok(change.categories.includes('Classes'));
  assert.equal(change.focus.relevance, 'high');
  assert.ok(change.focus.tags.includes('Mage/Frost'));
});

test('classifies launch operations separately from class changes', () => {
  const change = synthesizePost(post({
    id: 31000002,
    topic_title: 'WoW Forever Launch Maintenance',
    cooked: '<p>Realm login will be unavailable during maintenance.</p>',
  }));

  assert.ok(change.categories.includes('Launch & Servers'));
  assert.equal(change.focus.relevance, 'high');
  assert.ok(change.focus.tags.includes('Launch operations'));
});

test('ingestion is idempotent by Blizzard post id', () => {
  const first = ingestPostIntoState({}, post(), new Date('2026-10-26T12:01:00Z'));
  const second = ingestPostIntoState(
    first.state,
    post(),
    new Date('2026-10-26T12:02:00Z'),
  );

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.state.changes.length, 1);
  assert.equal(second.state.pending_change_ids.length, 1);
});

test('briefing waits for ten quiet minutes', () => {
  const ingested = ingestPostIntoState(
    {},
    post(),
    new Date('2026-10-26T12:00:00Z'),
  );

  assert.equal(
    briefingDue(ingested.state, Date.parse('2026-10-26T12:09:59Z')),
    false,
  );
  assert.equal(
    briefingDue(ingested.state, Date.parse('2026-10-26T12:10:00Z')),
    true,
  );
});

test('briefing groups changes and exposes focus items', () => {
  let state = ingestPostIntoState(
    {},
    post(),
    new Date('2026-10-26T12:00:00Z'),
  ).state;

  state = ingestPostIntoState(
    state,
    post({
      id: 31000003,
      topic_title: 'Profession Recipe Updates',
      cooked: '<p>Tailoring recipes have updated material requirements.</p>',
    }),
    new Date('2026-10-26T12:01:00Z'),
  ).state;

  const briefing = buildBriefing(
    state,
    new Date('2026-10-26T12:11:00Z'),
  );

  assert.equal(briefing.change_count, 2);
  assert.ok(briefing.groups.some((group) => group.category === 'Classes'));
  assert.ok(briefing.groups.some((group) => group.category === 'Professions'));
  assert.ok(briefing.focus.length >= 2);

  const cleared = markBriefingSent(
    state,
    new Date('2026-10-26T12:11:00Z'),
  );
  assert.deepEqual(cleared.pending_change_ids, []);
  assert.equal(cleared.brief_sequence, 1);
});
