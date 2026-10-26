import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isForeverRelevant,
  normalizedFingerprint,
  officialArticleUrl,
} from './core.mjs';

test('all Blizzard posts in Forever General Discussion are relevant', () => {
  assert.equal(
    isForeverRelevant({
      category_id: 347,
      topic_title: 'An obscure developer reply',
      cooked: 'No explicit product name required.',
    }),
    true,
  );
});

test('all Blizzard posts in Forever Community Connections are relevant', () => {
  assert.equal(isForeverRelevant({ category_id: 348 }), true);
});

test('retired Beta category remains covered for late blueposts', () => {
  assert.equal(isForeverRelevant({ category_id: 349 }), true);
});

test('Blizzard News outside the Forever categories is included when explicitly about Forever', () => {
  assert.equal(
    isForeverRelevant({
      category_id: 171,
      topic_title: 'Gather Around the Campfire in World of Warcraft: Forever',
    }),
    true,
  );
});

test('generic hotfix post is included when its body contains a Forever section', () => {
  assert.equal(
    isForeverRelevant({
      category_id: 171,
      topic_title: 'World of Warcraft Hotfixes - November 5',
      cooked: '<h2>WoW: Forever</h2><p>Fixed a dungeon issue.</p>',
    }),
    true,
  );
});

test('unrelated Blizzard news is excluded', () => {
  assert.equal(
    isForeverRelevant({
      category_id: 171,
      topic_title: 'Get Up to 50% In Fall Savings',
      cooked: 'Deals on Midnight and game services.',
    }),
    false,
  );
});

test('duplicate mirror posts share a fingerprint when title and body match', () => {
  const a = {
    topic_title: 'Thank You For Testing the WoW Forever Beta',
    cooked: '<p>Thanks for testing. See you on November 4.</p>',
  };
  const b = {
    topic_title: 'Thank You For Testing the WoW Forever Beta',
    cooked: 'Thanks for testing. See you on November 4.',
  };
  assert.equal(normalizedFingerprint(a), normalizedFingerprint(b));
});

test('extracts official WoW news article URL from mirrored Blizzard post', () => {
  assert.equal(
    officialArticleUrl({
      cooked:
        '<a href="https://worldofwarcraft.blizzard.com/en-us/news/24301455">View Full Article</a>',
    }),
    'https://worldofwarcraft.blizzard.com/en-us/news/24301455',
  );
});
