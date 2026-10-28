import { evaluateObservation, resolveStatus } from './core.mjs';
import { collectEvidence } from './sensors.mjs';
import { sendDiscord } from './discord.mjs';

function statesEqual(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

export async function executeSentry({
  profile, stateStore, tcpConnect, webhookUrl, runtimeLabel,
  mentionRoleId = null, fetchImpl = fetch, now = new Date(),
}) {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const [previousRaw, diagnostics] = await Promise.all([
    stateStore.get(),
    collectEvidence(profile, { tcpConnect, fetchImpl, runtimeLabel, nowMs }),
  ]);

  const observed = resolveStatus(profile, diagnostics);
  const decision = evaluateObservation(profile, previousRaw, observed, nowIso);

  console.log(JSON.stringify({
    profile: profile.id,
    runtime: runtimeLabel,
    observed,
    sources: diagnostics,
    previous: decision.previous,
    action: decision.action,
    health_refresh: Boolean(decision.health_refresh),
    bootstrap: decision.bootstrap,
  }, null, 2));

  if (decision.action) {
    await sendDiscord({
      webhookUrl, kind: decision.action, profile, observed,
      previous: decision.previous, diagnostics, runtimeLabel, mentionRoleId, fetchImpl,
    });
  }

  if (!statesEqual(previousRaw, decision.next)) {
    await stateStore.put(decision.next);
  }

  if (decision.bootstrap) {
    console.log(
      `Bootstrapped ${profile.id} realm sentry at ${observed.status}; no Discord notification sent.`,
    );
  } else if (decision.action === 'transition') {
    console.log(
      `Realm-status transition sent: ${decision.previous.status} -> ${observed.status} (${observed.confidence}).`,
    );
  } else if (decision.health_refresh) {
    console.log(
      `Realm sentry internal health marker refreshed: ${observed.status} (${observed.confidence}); no Discord notification sent.`,
    );
  } else if (observed.status === 'unknown') {
    console.warn(
      `Realm status inconclusive; streak=${decision.next.unknown_streak}. No outage asserted.`,
    );
  } else {
    console.log(
      `No realm-status transition: still ${observed.status} (${observed.confidence}).`,
    );
  }

  return {
    profile: profile.id,
    runtime: runtimeLabel,
    observed,
    state: decision.next,
    action: decision.action,
    health_refresh: Boolean(decision.health_refresh),
    bootstrap: decision.bootstrap,
    diagnostics,
  };
}
