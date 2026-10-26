function roleMention(roleId) {
  const id = /^\d{15,22}$/.test(String(roleId || '').trim())
    ? String(roleId).trim()
    : null;
  return {
    content: id ? `<@&${id}>` : undefined,
    allowed_mentions: id ? { parse: [], roles: [id] } : { parse: [] },
  };
}

function clip(value, max) {
  const text = String(value || '');
  return text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function itemLine(change) {
  const marker =
    change.priority === 'high'
      ? '◆'
      : change.priority === 'medium'
        ? '•'
        : '·';

  return `${marker} [${clip(change.title, 96)}](${change.url}) — ${clip(change.summary, 180)}`;
}

export function briefingPayload(briefing, mentionRoleId = null) {
  const fields = [];
  let fieldBudget = 4700;

  for (const group of briefing.groups.slice(0, 10)) {
    const lines = [];
    for (const item of group.items) {
      const candidate = itemLine(item);
      const nextLength = lines.join('\n').length + candidate.length + 1;
      if (nextLength > 900) {
        lines.push('…additional changes omitted from this category.');
        break;
      }
      lines.push(candidate);
    }

    const value = lines.join('\n') || 'No summarized changes.';
    const cost = group.category.length + value.length;
    if (cost > fieldBudget) break;

    fields.push({
      name: group.category,
      value,
      inline: false,
    });
    fieldBudget -= cost;
  }


  const historical = briefing.kind === 'historical';
  const title = historical
    ? `Forever historical briefing · #${briefing.sequence}`
    : `Forever change briefing · #${briefing.sequence}`;

  const windowText = briefing.source_window
    ? ` Source window: ${briefing.source_window}.`
    : '';

  const description = historical
    ? `Controlled historical backfill: ${briefing.change_count} Blizzard-authored Forever update${briefing.change_count === 1 ? '' : 's'} synthesized into the ledger.${windowText}`
    : `${briefing.change_count} Blizzard-authored Forever update${briefing.change_count === 1 ? '' : 's'} synthesized since the previous briefing.`;

  const mention = roleMention(mentionRoleId);

  return {
    username: 'Forever Briefing',
    content: mention.content,
    allowed_mentions: mention.allowed_mentions,
    embeds: [{
      title,
      description: clip(description, 900),
      fields,
      timestamp: briefing.generated_at,
      footer: {
        text: historical
          ? 'Controlled historical backfill · deterministic synthesis'
          : 'Deterministic synthesis · source: Blizzard-authored posts',
      },
    }],
  };
}

export async function sendBriefing(
  webhookUrl,
  briefing,
  fetchImpl = fetch,
  mentionRoleId = null,
) {
  if (!webhookUrl) {
    return { sent: false, reason: 'webhook-missing' };
  }

  const separator = webhookUrl.includes('?') ? '&' : '?';
  const response = await fetchImpl(`${webhookUrl}${separator}wait=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'ForeverBriefing/1.0 (cloudflare-worker)',
    },
    body: JSON.stringify(briefingPayload(briefing, mentionRoleId)),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Forever briefing Discord send -> HTTP ${response.status}`);
  }

  return { sent: true, reason: null };
}
