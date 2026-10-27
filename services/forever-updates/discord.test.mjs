import assert from 'node:assert/strict';
import test from 'node:test';

import { sendUpdate } from './discord.mjs';

test('Forever update pings only the configured tools role', async () => {
  let payload;
  const fetchImpl = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true };
  };

  await sendUpdate(
    'https://discord.test/webhook',
    {
      id: 1,
      topic_id: 2,
      post_number: 1,
      category_id: 347,
      topic_title: 'Test Forever update',
      cooked: '<p>Test body.</p>',
      created_at: '2026-10-26T05:00:00.000Z',
    },
    fetchImpl,
    '123456789012345678',
  );

  assert.equal(payload.content, '<@&123456789012345678>');
  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    roles: ['123456789012345678'],
  });
});


test('Forever update excerpts stay compact and preserve paragraph breaks', async () => {
  let payload;
  const fetchImpl = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true };
  };

  const first = 'First paragraph '.repeat(28).trim();
  const second = 'Second paragraph '.repeat(28).trim();
  const third = 'Third paragraph '.repeat(28).trim();

  await sendUpdate(
    'https://discord.test/webhook',
    {
      id: 3,
      topic_id: 4,
      post_number: 1,
      category_id: 347,
      topic_title: 'Long Forever update',
      cooked: `<p>${first}</p><p>${second}</p><p>${third}</p>`,
      created_at: '2026-10-27T12:00:00.000Z',
    },
    fetchImpl,
    '123456789012345678',
  );

  const description = payload.embeds[0].description;
  assert.ok(description.length <= 850);
  assert.ok(description.endsWith('…'));
  assert.ok(description.includes('\n\n'));
});
