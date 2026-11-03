import assert from 'node:assert/strict';
import test from 'node:test';
import { runIndependentStages } from './orchestrator.mjs';

test('Blizzard failure cannot block Wowhead collection or daily briefing', async () => {
  const calls = [];
  const errors = [];
  const results = await runIndependentStages([
    ['Blizzard', async () => { calls.push('Blizzard'); throw new Error('HTTP 503'); }],
    ['Wowhead', async () => { calls.push('Wowhead'); return { sent: 1 }; }],
    ['Backfill', async () => { calls.push('Backfill'); }],
    ['Briefing', async () => { calls.push('Briefing'); return { sent: true }; }],
  ], (...values) => errors.push(values));

  assert.deepEqual(calls, ['Blizzard', 'Wowhead', 'Backfill', 'Briefing']);
  assert.deepEqual(results.map(({ ok }) => ok), [false, true, true, true]);
  assert.equal(results[3].value.sent, true);
  assert.match(errors[0][0], /Blizzard failed: HTTP 503/);
});

test('Wowhead and historical backfill failures do not block daily briefing', async () => {
  const calls = [];
  const results = await runIndependentStages([
    ['Blizzard', async () => { calls.push('Blizzard'); }],
    ['Wowhead', async () => { calls.push('Wowhead'); throw new Error('malformed RSS'); }],
    ['Backfill', async () => { calls.push('Backfill'); throw new Error('backfill unavailable'); }],
    ['Briefing', async () => { calls.push('Briefing'); return { sent: true }; }],
  ], () => {});

  assert.deepEqual(calls, ['Blizzard', 'Wowhead', 'Backfill', 'Briefing']);
  assert.deepEqual(results.map(({ ok }) => ok), [true, false, false, true]);
  assert.equal(results[3].value.sent, true);
});

test('each task runs sequentially to avoid lost ledger writes', async () => {
  const calls = [];
  await runIndependentStages([
    ['Blizzard', async () => {
      calls.push('blizzard-start');
      await Promise.resolve();
      calls.push('blizzard-finish');
    }],
    ['Wowhead', async () => { calls.push('wowhead-start'); }],
  ]);
  assert.deepEqual(calls, ['blizzard-start', 'blizzard-finish', 'wowhead-start']);
});
