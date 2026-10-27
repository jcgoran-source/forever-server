import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIEFING_INTERVAL_MS,
  BRIEFING_TIME_ZONE,
  briefingDue,
  briefingSlotKey,
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

test('classifies class changes without personalized focus metadata', () => {
  const change = synthesizePost(post());
  assert.ok(change.categories.includes('Classes'));
  assert.equal(change.priority, 'medium');
  assert.equal(Object.hasOwn(change, 'focus'), false);
});

test('classifies launch operations as a general Forever domain', () => {
  const change = synthesizePost(post({
    id: 31000002,
    topic_title: 'WoW Forever Launch Maintenance',
    cooked: '<p>Realm login will be unavailable during maintenance.</p>',
  }));

  assert.ok(change.categories.includes('Launch & Servers'));
  assert.equal(change.priority, 'high');
  assert.equal(Object.hasOwn(change, 'focus'), false);
});

test('ingestion is idempotent by Blizzard post id', () => {
  const first = ingestPostIntoState(
    {},
    post(),
    new Date('2026-10-26T12:01:00Z'),
  );
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

test('briefing uses six-hour America/Los_Angeles clock slots', () => {
  const ingested = ingestPostIntoState(
    {},
    post(),
    new Date('2026-10-27T12:30:00Z'),
  );

  assert.equal(BRIEFING_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(BRIEFING_TIME_ZONE, 'America/Los_Angeles');

  // 05:30 PDT pending update waits for the 06:00 PDT slot.
  assert.equal(
    briefingDue(ingested.state, Date.parse('2026-10-27T12:59:59Z')),
    false,
  );
  assert.equal(
    briefingDue(ingested.state, Date.parse('2026-10-27T13:00:00Z')),
    true,
  );
});

test('an update arriving after a slot rolls into the next six-hour briefing', () => {
  const ingested = ingestPostIntoState(
    {},
    post(),
    new Date('2026-10-27T13:01:00Z'),
  );

  // 06:01 PDT arrived just after the 06:00 slot, so noon PDT is next.
  assert.equal(
    briefingDue(ingested.state, Date.parse('2026-10-27T13:05:00Z')),
    false,
  );
  assert.equal(
    briefingDue(ingested.state, Date.parse('2026-10-27T19:00:00Z')),
    true,
  );
});

test('briefing slot calculation follows Pacific daylight-saving time', () => {
  assert.equal(
    briefingSlotKey(new Date('2026-10-27T13:00:00Z')),
    '2026-10-27-06',
  );
  assert.equal(
    briefingSlotKey(new Date('2026-11-02T14:00:00Z')),
    '2026-11-02-06',
  );
});

test('later updates join the current batch without resetting its slot', () => {
  let state = ingestPostIntoState(
    {},
    post(),
    new Date('2026-10-27T12:00:00Z'),
  ).state;

  state = ingestPostIntoState(
    state,
    post({
      id: 31000003,
      topic_title: 'Profession Recipe Updates',
      cooked: '<p>Profession recipes have updated material requirements.</p>',
    }),
    new Date('2026-10-27T12:45:00Z'),
  ).state;

  assert.equal(state.first_pending_at, '2026-10-27T12:00:00.000Z');
  assert.equal(
    briefingDue(state, Date.parse('2026-10-27T13:00:00Z')),
    true,
  );
});

test('briefing groups general changes by domain', () => {
  let state = ingestPostIntoState(
    {},
    post(),
    new Date('2026-10-26T12:00:00Z'),
  ).state;

  state = ingestPostIntoState(
    state,
    post({
      id: 31000004,
      topic_title: 'Profession Recipe Updates',
      cooked: '<p>Profession recipes have updated material requirements.</p>',
    }),
    new Date('2026-10-26T12:01:00Z'),
  ).state;

  const briefing = buildBriefing(
    state,
    new Date('2026-10-27T19:00:00Z'),
  );

  assert.equal(briefing.change_count, 2);
  assert.ok(briefing.groups.some((group) => group.category === 'Classes'));
  assert.ok(briefing.groups.some((group) => group.category === 'Professions'));
  assert.equal(Object.hasOwn(briefing, 'focus'), false);

  const cleared = markBriefingSent(
    state,
    new Date('2026-10-27T19:00:00Z'),
  );
  assert.deepEqual(cleared.pending_change_ids, []);
  assert.equal(cleared.brief_sequence, 1);
});
