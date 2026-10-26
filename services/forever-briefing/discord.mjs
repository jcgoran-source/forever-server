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

  return `${marker} [${clip(change.title, 120)}](${change.url}) — ${clip(change.summary, 260)}`;
}

export function briefingPayload(briefing) {
  const fields = [];

  for (const group of briefing.groups.slice(0, 12)) {
    const lines = [];
    for (const item of group.items) {
      const candidate = itemLine(item);
      if ((lines.join('\n').length + candidate.length + 1) > 980) {
        lines.push('…additional changes omitted from this field.');
        break;
      }
      lines.push(candidate);
    }

    fields.push({
      name: group.category,
      value: lines.join('\n') || 'No summarized changes.',
      inline: false,
    });
  }

  if (briefing.focus.length) {
    const focusLines = [];
    for (const change of briefing.focus.slice(0, 8)) {
      const tags = change.focus.tags?.length
        ? ` [${change.focus.tags.join(', ')}]`
        : '';
      const line =
        `• **${change.focus.relevance.toUpperCase()}**${tags} — ` +
        `${change.focus.reason || change.title}`;

      if ((focusLines.join('\n').length + line.length + 1) > 980) break;
      focusLines.push(line);
    }

    fields.push({
      name: 'Launch-plan relevance',
      value: focusLines.join('\n'),
      inline: false,
    });
  }

  return {
    username: 'Forever Briefing',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Forever change briefing · #${briefing.sequence}`,
      description:
        `${briefing.change_count} Blizzard-authored Forever update` +
        `${briefing.change_count === 1 ? '' : 's'} synthesized since the previous briefing.`,
      fields,
      timestamp: briefing.generated_at,
      footer: {
        text: 'Deterministic synthesis · source: Blizzard-authored posts',
      },
    }],
  };
}

export async function sendBriefing(
  webhookUrl,
  briefing,
  fetchImpl = fetch,
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
    body: JSON.stringify(briefingPayload(briefing)),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Forever briefing Discord send -> HTTP ${response.status}`);
  }

  return { sent: true, reason: null };
}
