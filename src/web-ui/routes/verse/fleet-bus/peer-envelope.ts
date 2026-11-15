const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
// eslint-disable-next-line no-control-regex -- remove control bytes from untrusted display text.
const clean = (value: string, cap: number) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, cap);

/** Readable display only; peer envelopes grant no authority. */
export function peerEnvelopeSummary(body: unknown): { label: string; text: string } | null {
  const data = record(body);
  if (!data) return null;
  if (data.kind === 'peer.message') {
    const peer = record(data.peer);
    if (!peer || typeof peer.fromAgent !== 'string' || typeof peer.text !== 'string'
      || typeof peer.kind !== 'string' || !['task', 'review', 'handoff', 'query', 'social'].includes(peer.kind)
      || typeof peer.hopCount !== 'number' || !Number.isInteger(peer.hopCount) || peer.hopCount < 1 || peer.hopCount > 8) return null;
    const directed = typeof peer.toAgent === 'string' && !('channel' in peer);
    const channel = typeof peer.channel === 'string' && !('toAgent' in peer);
    if (!directed && !channel) return null;
    const target = directed ? clean(peer.toAgent as string, 64) : `#${clean(peer.channel as string, 64)}`;
    return { label: `${clean(peer.fromAgent, 64)} → ${target} · ${peer.kind} · hop ${peer.hopCount}/8`,
      text: clean(peer.text, 500) };
  }
  if (data.kind === 'peer.escalation' && typeof data.origin === 'string' && typeof data.reason === 'string') {
    return { label: 'peer loop/hop cap', text: clean(`origin ${data.origin}: ${data.reason}`, 500) };
  }
  if (data.kind === 'peer.draft' && typeof data.action === 'string' && typeof data.name === 'string') {
    return { label: 'agentnet draft', text: clean(`${data.action}: ${data.name} (needs reviewed provisioning)`, 500) };
  }
  return null;
}
