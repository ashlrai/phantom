import type { AgentBusReceipt } from './agent-bus-queries.js';

const parentOf = (row: AgentBusReceipt): string | null => {
  const body = row.envelope.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const replyTo = (body as Record<string, unknown>).replyTo;
  return typeof replyTo === 'string' && replyTo ? replyTo : null;
};

export function threadOf(messages: readonly AgentBusReceipt[], id: string): { rootId: string; ids: string[] } {
  const byId = new Map(messages.map(row => [row.envelope.id, row]));
  if (!byId.has(id)) return { rootId: id, ids: [] };
  const children = new Map<string, string[]>();
  for (const row of messages) {
    const parent = parentOf(row);
    if (parent) children.set(parent, [...children.get(parent) ?? [], row.envelope.id]);
  }
  let rootId = id;
  const ancestors = new Set([id]);
  for (let hops = 0; hops < 50; hops++) {
    const parent = parentOf(byId.get(rootId)!);
    if (!parent || !byId.has(parent) || ancestors.has(parent)) break;
    rootId = parent;
    ancestors.add(parent);
  }
  const selected = new Set([rootId]);
  const pending = [rootId];
  for (let i = 0; i < pending.length; i++) {
    for (const child of children.get(pending[i]!) ?? []) {
      if (!selected.has(child)) { selected.add(child); pending.push(child); }
    }
  }
  const ids = [...selected].sort((a, b) => {
    const left = byId.get(a)!, right = byId.get(b)!;
    return left.receivedAt - right.receivedAt || left.cursor - right.cursor;
  });
  return { rootId, ids };
}

export function replyCounts(messages: readonly AgentBusReceipt[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of messages) {
    const parent = parentOf(row);
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

export function threadHeadline(thread: { rootId: string; ids: string[] }, messages: readonly AgentBusReceipt[], now = Date.now()): string {
  const byId = new Map(messages.map(row => [row.envelope.id, row]));
  const last = [...thread.ids].reverse().find(id => id !== thread.rootId && byId.has(id));
  const count = `${thread.ids.length} ${thread.ids.length === 1 ? 'message' : 'messages'}`;
  if (!last) return `Thread · ${count}`;
  const row = byId.get(last)!;
  const seconds = Math.max(0, Math.round((now - row.receivedAt) / 1000));
  const age = seconds < 60 ? `${seconds} sec` : seconds < 3600 ? `${Math.round(seconds / 60)} min`
    : seconds < 86400 ? `${Math.round(seconds / 3600)} hr` : `${Math.round(seconds / 86400)} days`;
  return `Thread · ${count} · last reply from ${row.envelope.from} ${age} ago`;
}
