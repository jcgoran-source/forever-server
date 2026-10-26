import { foreverDbState, statusLabel } from './core.mjs';

function sourceSummary(diagnostics) {
  const db = foreverDbState(diagnostics.foreverDb);
  const dbFresh =
    diagnostics.foreverDb?.login_fresh && diagnostics.foreverDb?.realm_fresh;

  const dbText =
    diagnostics.foreverDb?.phase === 'prelaunch' &&
    diagnostics.foreverDb?.login_fresh
      ? `LOGIN ANSWERING · observed ${diagnostics.foreverDb.login_checked_at} · realm check not yet published`
      : dbFresh
        ? `${statusLabel(db)} · login checked ${diagnostics.foreverDb.login_checked_at} · realm checked ${diagnostics.foreverDb.realm_checked_at}`
        : `UNKNOWN · ${diagnostics.foreverDb?.error || 'stale/unparseable'}`;

  const directText = [
    `login ${diagnostics.loginTcp?.up ? `answering (${diagnostics.loginTcp.latency} ms)` : 'inconclusive'}`,
    `realm ${diagnostics.realmTcp?.up ? `answering (${diagnostics.realmTcp.latency} ms)` : 'inconclusive'}`,
  ].join(' · ');

  const officialText = diagnostics.official?.signal
    ? `${diagnostics.official.signal.toUpperCase()} · ${diagnostics.official.title}`
    : diagnostics.official?.error
      ? `unavailable · ${diagnostics.official.error}`
      : 'no recent explicit state signal';

  return { dbText, directText, officialText };
}

function roleMention(roleId) {
  const id = /^\d{15,22}$/.test(String(roleId || '').trim())
    ? String(roleId).trim()
    : null;
  return {
    content: id ? `<@&${id}>` : undefined,
    allowed_mentions: id ? { parse: [], roles: [id] } : { parse: [] },
  };
}

export async function sendDiscord({
  webhookUrl, kind, profile, observed, previous, diagnostics,
  runtimeLabel, mentionRoleId = null, fetchImpl = fetch,
}) {
  if (!webhookUrl) {
    throw new Error('DISCORD_REALM_STATUS_WEBHOOK_URL is not configured');
  }

  const styles = {
    online: [`🟢 ${profile.displayName} is ONLINE`, 0x57f287],
    offline: [`🔴 ${profile.displayName} is OFFLINE`, 0xed4245],
    degraded: [`🟡 ${profile.displayName} is DEGRADED`, 0xfee75c],
    prelaunch: [`🕓 ${profile.displayName} is PRE-LAUNCH`, 0x5865f2],
    unknown: [`⚪ ${profile.displayName} status is UNKNOWN`, 0x99aab5],
  };

  let [title, color] = styles[observed.status] || styles.unknown;
  let description = observed.reason;

  if (kind === 'heartbeat') {
    title = `💓 Realm sentry healthy · ${statusLabel(observed.status)}`;
    color = styles[observed.status]?.[1] || 0x99aab5;
    description = 'The sentry is healthy and its evidence sources produced a usable status.';
  } else if (observed.status === 'unknown') {
    description =
      `${observed.reason} No outage is being asserted. Last confirmed state: ${statusLabel(previous.confirmed_status)}.`;
  }

  const summary = sourceSummary(diagnostics);
  const mention = roleMention(mentionRoleId);
  const payload = {
    username: 'Forever Realm Sentry',
    content: mention.content,
    allowed_mentions: mention.allowed_mentions,
    embeds: [{
      title,
      description: description.slice(0, 4096),
      color,
      fields: [
        { name: 'Environment', value: profile.id, inline: true },
        { name: 'Confidence', value: observed.confidence, inline: true },
        { name: 'Runtime', value: runtimeLabel, inline: true },
        { name: 'ForeverDB', value: summary.dbText.slice(0, 1024), inline: false },
        { name: 'Direct probes', value: summary.directText.slice(0, 1024), inline: false },
        { name: 'Recent Blizzard signal', value: summary.officialText.slice(0, 1024), inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: kind === 'heartbeat'
          ? '24-hour health heartbeat'
          : `Previous announced state: ${statusLabel(previous.status)}`,
      },
    }],
  };

  const separator = webhookUrl.includes('?') ? '&' : '?';
  const response = await fetchImpl(`${webhookUrl}${separator}wait=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `ForeverRealmStatus/3.0 (${runtimeLabel})`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) throw new Error(`Discord send -> HTTP ${response.status}`);
}
