export interface PlannerAck { entryId: string; status: 'acked' | 'skipped' }
export function entryIdFromSource(source: string): string | null {
  return /^.+ \(([A-Za-z0-9._:-]{1,64})\)$/.exec(source)?.[1] ?? null;
}
export function plannerAckLabel(entry: { source: string }, acks: readonly PlannerAck[] | null | undefined): 'Acked by planner' | 'Not routable' | null {
  const id = entryIdFromSource(entry.source);
  const row = id ? acks?.slice().reverse().find(ack => ack.entryId === id) : undefined;
  return row ? row.status === 'acked' ? 'Acked by planner' : 'Not routable' : null;
}
