import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectWowheadUpdates,
  parseWowheadRss,
  WOWHEAD_FOREVER_RSS_URL,
} from './wowhead.mjs';
import { ingestWowheadIntoState } from '../forever-briefing/synthesizer.mjs';

const xml = String.raw`<?xml version="1.0"?>
<rss version="2.0"><channel><title>Forever News</title>
<item><title><![CDATA[New Mage Talents - WoW Forever]]></title>
<link>https://www.wowhead.com/forever/news/new-mage-talents-382871?utm_source=rss</link>
<pubDate>Fri, 30 Oct 2026 12:00:00 GMT</pubDate>
<description><![CDATA[<p>New Frost Mage talents &amp; spells.</p>]]></description>
<dc:creator><![CDATA[Reporter]]></dc:creator></item>
<item><title>Another Forever update</title>
<link>https://www.wowhead.com/forever/news/another-update-382872</link>
<pubDate>Sat, 31 Oct 2026 12:00:00 GMT</pubDate>
<description>More changes.</description></item>
</channel></rss>`;

test('parses RSS stories, publication times, CDATA and canonical URLs', () => {
  const items = parseWowheadRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, '382871');
  assert.equal(items[0].summary, 'New Frost Mage talents & spells.');
  assert.equal(items[0].author, 'Reporter');
  assert.equal(items[0].url, 'https://www.wowhead.com/forever/news/new-mage-talents-382871');
});

test('rejects HTML and unrelated sources instead of advancing state', () => {
  assert.throws(() => parseWowheadRss('<html>Blocked</html>'), /non-RSS/);
  assert.throws(() => parseWowheadRss(xml.replaceAll('www.wowhead.com', 'untrusted.test')), /no parseable/);
});

test('first poll silently seeds history, later polls send and synthesize new articles', async () => {
  let stored = {};
  let ledger = {};
  let rssReads = 0;
  const posts = [];
  const stateStore = {
    get: async () => stored,
    put: async (state) => { stored = state; },
  };
  const fetchImpl = async (url, opts) => {
    if (url === WOWHEAD_FOREVER_RSS_URL) {
      rssReads += 1;
      return { ok: true, text: async () => rssReads < 3 ? xml : xml.replace('</channel>', String.raw`<item><title>Professions updated for Forever</title>
<link>https://www.wowhead.com/forever/news/profession-update-382873</link>
<pubDate>Sat, 31 Oct 2026 14:00:00 GMT</pubDate>
<description>Tailoring recipe changes.</description></item></channel>`) };
    }
    const payload = JSON.parse(opts.body);
    posts.push(payload);
    return { ok: true };
  };
  const onRelevantArticle = async (article) => {
    ledger = ingestWowheadIntoState(ledger, article).state;
  };
  const first = await collectWowheadUpdates({ stateStore, webhookUrl: 'https://discord.test/webhook', fetchImpl, onRelevantArticle });
  assert.equal(first.bootstrapped, true);
  assert.equal(posts.length, 0);
  const second = await collectWowheadUpdates({ stateStore, webhookUrl: 'https://discord.test/webhook', fetchImpl, onRelevantArticle });
  assert.equal(second.sent, 0);
  const third = await collectWowheadUpdates({ stateStore, webhookUrl: 'https://discord.test/webhook', fetchImpl, onRelevantArticle });
  assert.equal(third.sent, 1);
  assert.equal(ledger.changes[0].source, 'Wowhead News');
  assert.ok(ledger.pending_change_ids.includes('wowhead:382873'));
  assert.equal(posts[0].embeds[0].footer.text, 'WoW Forever • Wowhead News');
  const fourth = await collectWowheadUpdates({ stateStore, webhookUrl: 'https://discord.test/webhook', fetchImpl, onRelevantArticle });
  assert.equal(fourth.sent, 0);
});
