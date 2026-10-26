import { DurableObject } from 'cloudflare:workers';

import { collectForeverUpdates } from './collector.mjs';
import {
  briefingDue,
  buildBriefing,
  ingestPostIntoState,
  markBriefingSent,
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
      `Synthesized Blizzard post ${post.id}: ${result.change.primary_category} · ${result.change.priority} · focus=${result.change.focus.relevance}.`,
    );
  }

  return result;
}

async function maybeDeliverBriefing(store, webhookUrl) {
  const current = await store.get();

  if (!briefingDue(current)) {
    return { due: false, sent: false };
  }

  const briefing = buildBriefing(current);
  const result = await sendBriefing(webhookUrl, briefing);

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
      });

      await maybeDeliverBriefing(
        briefingStore,
        env.DISCORD_FOREVER_BRIEFING_WEBHOOK_URL,
      );
    })());
  },
};
