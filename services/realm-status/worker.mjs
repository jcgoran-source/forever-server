import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';

import { getProfile } from './profiles.mjs';
import { executeSentry } from './sentry.mjs';

const LOOP_MS = 30 * 1000;
const WATCHDOG_MAX_FUTURE_MS = 45 * 1000;

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

export class SentryState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async getState() {
    return (await this.ctx.storage.get('state')) || {};
  }

  async putState(state) {
    await this.ctx.storage.put('state', state);
  }

  async runCheck() {
    const profile = getProfile(this.env.FOREVER_ENV || 'live');

    return executeSentry({
      profile,
      stateStore: {
        get: () => this.getState(),
        put: (state) => this.putState(state),
      },
      tcpConnect: cloudflareTcpConnect,
      webhookUrl: this.env.DISCORD_REALM_STATUS_WEBHOOK_URL,
      mentionRoleId: this.env.FOREVER_TOOLS_ROLE_ID,
      runtimeLabel: 'cloudflare-worker',
    });
  }

  async ensureLoop() {
    const now = Date.now();
    const alarm = await this.ctx.storage.getAlarm();

    if (
      alarm === null ||
      alarm <= now ||
      alarm > now + WATCHDOG_MAX_FUTURE_MS
    ) {
      const scheduledFor = now + 1000;
      await this.ctx.storage.setAlarm(scheduledFor);
      console.log(
        `Realm sentry alarm watchdog armed next check for ${new Date(scheduledFor).toISOString()}.`,
      );
      return { repaired: true, scheduled_for: scheduledFor };
    }

    console.log(
      `Realm sentry alarm healthy; next check at ${new Date(alarm).toISOString()}.`,
    );
    return { repaired: false, scheduled_for: alarm };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'GET' && url.pathname === '/state') {
      return Response.json(await this.getState());
    }

    if (method === 'PUT' && url.pathname === '/state') {
      const state = await request.json();
      await this.putState(state);
      return Response.json({ ok: true });
    }

    if (method === 'POST' && url.pathname === '/watchdog') {
      return Response.json(await this.ensureLoop());
    }

    return new Response('Method not allowed', { status: 405 });
  }

  async alarm() {
    const started = Date.now();

    try {
      await this.runCheck();
    } catch (error) {
      console.error(
        'Realm sentry alarm check failed:',
        error?.stack || error,
      );
    } finally {
      const next = Math.max(Date.now(), started) + LOOP_MS;
      await this.ctx.storage.setAlarm(next);
      console.log(
        `Realm sentry next 30-second alarm scheduled for ${new Date(next).toISOString()}.`,
      );
    }
  }
}

function sentryStub(env) {
  const profile = getProfile(env.FOREVER_ENV || 'live');
  return env.SENTRY_STATE.get(env.SENTRY_STATE.idFromName(profile.id));
}

export default {
  async scheduled(controller, env, ctx) {
    const stub = sentryStub(env);
    ctx.waitUntil(
      stub.fetch('https://state.internal/watchdog', { method: 'POST' }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const profile = getProfile(env.FOREVER_ENV || 'live');

    if (url.pathname === '/health') {
      const response = await sentryStub(env).fetch('https://state.internal/state');
      const state = await response.json();
      return Response.json({
        service: 'forever-realm-status',
        profile: profile.id,
        runtime: 'cloudflare-worker',
        cadence: {
          alarm_ms: LOOP_MS,
          cron_watchdog: '* * * * *',
        },
        state,
      });
    }

    return new Response('Forever Realm Sentry', { status: 200 });
  },
};
