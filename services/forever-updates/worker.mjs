import { DurableObject } from 'cloudflare:workers';

import { collectForeverUpdates } from './collector.mjs';

export class UpdateState extends DurableObject {
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

function stateStore(env) {
  const id = env.UPDATE_STATE.idFromName('live');
  const stub = env.UPDATE_STATE.get(id);
  const url = 'https://state.internal/state';

  return {
    async get() {
      const response = await stub.fetch(url);
      if (!response.ok) {
        throw new Error(
          `Forever updates state GET -> HTTP ${response.status}`,
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
          `Forever updates state PUT -> HTTP ${response.status}`,
        );
      }
    },
  };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      collectForeverUpdates({
        stateStore: stateStore(env),
        webhookUrl: env.DISCORD_FOREVER_UPDATES_WEBHOOK_URL,
      }),
    );
  },
};
