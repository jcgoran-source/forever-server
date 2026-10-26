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
