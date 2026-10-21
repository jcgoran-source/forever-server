import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';

import { getProfile } from './profiles.mjs';
import { executeSentry } from './sentry.mjs';

export class SentryState extends DurableObject {
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

async function cloudflareTcpConnect(host, port, timeoutMs = 3500) {
  const started = Date.now();
  let socket;
  let timer;

  try {
    socket = connect({ hostname: host, port });
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);

    if (timer) clearTimeout(timer);
    const latency = Date.now() - started;
    await socket.close().catch(() => {});
    return { up: true, latency, error: null };
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (socket) await socket.close().catch(() => {});
    return {
      up: false,
      latency: null,
      error: String(error?.code || error?.message || error),
    };
  }
}

function durableStateStore(env, profile) {
  const id = env.SENTRY_STATE.idFromName(profile.id);
  const stub = env.SENTRY_STATE.get(id);
  const url = 'https://state.internal/state';

  return {
    async get() {
      const response = await stub.fetch(url);
      if (!response.ok) {
        throw new Error(`Durable Object state GET -> HTTP \${response.status}`);
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
        throw new Error(`Durable Object state PUT -> HTTP \${response.status}`);
      }
    },
  };
}

async function run(env) {
  const profile = getProfile(env.FOREVER_ENV || 'beta');
  return executeSentry({
    profile,
    stateStore: durableStateStore(env, profile),
    tcpConnect: cloudflareTcpConnect,
    webhookUrl: env.DISCORD_REALM_STATUS_WEBHOOK_URL,
    runtimeLabel: 'cloudflare-worker',
  });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const profile = getProfile(env.FOREVER_ENV || 'beta');

    if (url.pathname === '/health') {
      const state = await durableStateStore(env, profile).get();
      return Response.json({
        service: 'forever-realm-status',
        profile: profile.id,
        runtime: 'cloudflare-worker',
        state,
      });
    }

    return new Response('Forever Realm Sentry', { status: 200 });
  },
};
