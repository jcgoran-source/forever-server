import { DurableObject } from 'cloudflare:workers';

import { collectForeverUpdates } from './collector.mjs';
import { collectWowheadUpdates } from './wowhead.mjs';
import { runHistoricalBackfill } from '../forever-briefing/backfill.mjs';
import {
  briefingDue,
  buildBriefing,
  ingestPostIntoState,
  ingestWowheadIntoState,
  markBriefingSent,
  markHistoricalBriefingSent,
  normalizeBriefingState,
} from '../forever-briefing/synthesizer.mjs';
import { sendBriefing } from '../forever-briefing/discord.mjs';

class JsonState extends DurableObject {
  async fetch(request) {
    const method = request.method.toUpperCase();

    if (method === 'GET') {
      const state = (await this.ctx.storage.get('state')) || {};
      return Response.json(state);
    }

    if (method === 'PUT') {
      const state = await request.json();
      await this.ctx.storage.put('state', state);
      return Response.json({ ok: true });
    }

    return new Response('Method not allowed', { status: 405 });
  }
}

export class UpdateState extends JsonState {}
export class BriefingState extends JsonState {}

function durableStore(binding, name) {
  const id = binding.idFromName(name);
  const stub = binding.get(id);
  const url = 'https://state.internal/state';

  return {
    async get() {
      const response = await stub.fetch(url);
      if (!response.ok) {
        throw new Error(
          `Durable state GET (${name}) -> HTTP ${response.status}`,
        );
      }
      return response.json();
    },

    async put(state) {
      const response = await stub.fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (!response.ok) {
        throw new Error(
          `Durable state PUT (${name}) -> HTTP ${response.status}`,
        );
      }
    },
  };
}

async function ingestBriefingPost(store, post) {
  const current = await store.get();
  const result = ingestPostIntoState(current, post);

  if (!result.duplicate) {
    await store.put(result.state);
    console.log(
      `Synthesized Blizzard post ${post.id}: ${result.change.primary_category} · ${result.change.priority}.`,
    );
  }

  return result;
}

async function ingestWowheadArticle(store, article) {
  const current = await store.get();
  const result = ingestWowheadIntoState(current, article);
  if (!result.duplicate) {
    await store.put(result.state);
    console.log('Synthesized Wowhead article ' + article.id);
  }
  return result;
}

async function maybeRunHistoricalBackfill(store, webhookUrl, env) {
  const key = env.BRIEFING_BACKFILL_KEY;
  const since = env.BRIEFING_BACKFILL_SINCE;

  if (!key || !since) {
    return { configured: false, ran: false };
  }

  const current = normalizeBriefingState(await store.get());
  if (current.completed_backfills.includes(key)) {
    console.log(`Historical briefing backfill ${key} already completed; skipping.`);
    return { configured: true, ran: false, completed: true };
  }

  const limit = Math.max(
    1,
    Math.min(50, Number(env.BRIEFING_BACKFILL_LIMIT || 12) || 12),
  );

  const result = await runHistoricalBackfill({
    rawState: current,
    since,
    limit,
  });

  if (!result.imported_count) {
    const now = new Date();
    const completed = {
      ...result.state,
      completed_backfills: [
        ...result.state.completed_backfills.filter((value) => value !== key),
        key,
      ].slice(-50),
      updated_at: now.toISOString(),
    };
    await store.put(completed);
    console.log(
      `Historical briefing backfill ${key} found no new ledger records; marked complete.`,
    );
    return {
      configured: true,
      ran: true,
      completed: true,
      imported_count: 0,
    };
  }

  const delivery = await sendBriefing(
    webhookUrl,
    result.briefing,
    fetch,
    env.FOREVER_TOOLS_ROLE_ID,
  );
  if (!delivery.sent) {
    throw new Error(
      `Historical briefing backfill ${key} is ready but the briefing webhook is not configured.`,
    );
  }

  const finalState = markHistoricalBriefingSent(result.state, key);
  await store.put(finalState);

  console.log(JSON.stringify({
    historical_backfill: key,
    source_since: since,
    tracker_window_count: result.tracker_window_count,
    selected_count: result.selected_count,
    imported_count: result.imported_count,
    briefing_sequence: result.briefing.sequence,
    imported_posts: result.imported_posts,
  }, null, 2));

  return {
    configured: true,
    ran: true,
    completed: true,
    imported_count: result.imported_count,
    briefing: result.briefing,
  };
}

async function maybeDeliverBriefing(store, webhookUrl, mentionRoleId = null) {
  const current = await store.get();

  if (!briefingDue(current)) {
    return { due: false, sent: false };
  }

  const briefing = buildBriefing(current);
  const result = await sendBriefing(
    webhookUrl,
    briefing,
    fetch,
    mentionRoleId,
  );

  if (!result.sent) {
    console.log(
      `Forever briefing #${briefing.sequence} is ready with ${briefing.change_count} change(s), but DISCORD_FOREVER_BRIEFING_WEBHOOK_URL is not configured.`,
    );
    return { due: true, sent: false, briefing };
  }

  await store.put(markBriefingSent(current));
  console.log(
    `Sent Forever briefing #${briefing.sequence} with ${briefing.change_count} synthesized change(s).`,
  );

  return { due: true, sent: true, briefing };
}

export default {
  async scheduled(controller, env, ctx) {
    const updatesStore = durableStore(env.UPDATE_STATE, 'live-updates');
    const briefingStore = durableStore(env.BRIEFING_STATE, 'live-briefing');

    ctx.waitUntil((async () => {
      await collectForeverUpdates({
        stateStore: updatesStore,
        webhookUrl: env.DISCORD_FOREVER_UPDATES_WEBHOOK_URL,
        onRelevantPost: (post) => ingestBriefingPost(briefingStore, post),
        mentionRoleId: env.FOREVER_TOOLS_ROLE_ID,
      });

      // Wowhead failures are isolated from Blizzard ingestion and briefing delivery.
      try {
        await collectWowheadUpdates({
          stateStore: durableStore(env.UPDATE_STATE, 'wowhead-forever-news'),
          webhookUrl: env.DISCORD_FOREVER_UPDATES_WEBHOOK_URL,
          onRelevantArticle: (article) => ingestWowheadArticle(briefingStore, article),
          mentionRoleId: env.FOREVER_TOOLS_ROLE_ID,
        });
      } catch (error) {
        console.error('Wowhead Forever RSS collection failed:', error);
      }

      await maybeRunHistoricalBackfill(
        briefingStore,
        env.DISCORD_FOREVER_BRIEFING_WEBHOOK_URL,
        env,
      );

      await maybeDeliverBriefing(
        briefingStore,
        env.DISCORD_FOREVER_BRIEFING_WEBHOOK_URL,
        env.FOREVER_TOOLS_ROLE_ID,
      );
    })());
  },
};
