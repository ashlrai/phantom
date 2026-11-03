export interface QueueAgeEvent {
  /** Repository-qualified PR identity, for example ashlrai/phantom#42. */
  pr: string;
  event: 'created' | 'queue_entered' | 'merged';
  ts: string;
}

/** Exact duplicate events are harmless; repeated distinct boundaries are ambiguous. */
export function queueAge(events: readonly QueueAgeEvent[]) {
  const prs = new Map<string, Map<string, Set<number>>>();
  for (const row of events) {
    const times = prs.get(row.pr) ?? new Map<string, Set<number>>();
    const values = times.get(row.event) ?? new Set<number>();
    values.add(Date.parse(row.ts)); times.set(row.event, values); prs.set(row.pr, times);
  }
  const phases = [
    ['creation_to_queue', 'created', 'queue_entered'],
    ['queue_to_merge', 'queue_entered', 'merged'],
    ['creation_to_merge', 'created', 'merged'],
  ] as const;
  const entries = [...prs].map(([pr, times]) => ({ pr, delays: phases.map(([phase, start, end]) => {
    const a = times.get(start), b = times.get(end);
    const first = a?.size === 1 ? [...a][0]! : undefined;
    const last = b?.size === 1 ? [...b][0]! : undefined;
    const reason = !a || !b ? 'missing' : a.size !== 1 || b.size !== 1 ? 'ambiguous'
      : last! < first! ? 'reversed' : null;
    return { phase, seconds: reason === null ? (last! - first!) / 1000 : null, reason };
  }) })).sort((a, b) => a.pr.localeCompare(b.pr));
  const oldest_delays = entries.flatMap(row => row.delays.filter(d => d.seconds !== null).map(d => ({ pr: row.pr, ...d })))
    .sort((a, b) => b.seconds! - a.seconds! || a.pr.localeCompare(b.pr) || a.phase.localeCompare(b.phase));
  return { schema: 'fleet.queue-age.v1' as const, prs: entries.length, entries, oldest_delays };
}

export function validQueueAgeEvents(value: unknown): value is QueueAgeEvent[] {
  return Array.isArray(value) && value.every(row => row && typeof row === 'object'
    && typeof row.pr === 'string' && /^[^\s/#]+\/[^\s/#]+#[1-9]\d*$/.test(row.pr)
    && ['created', 'queue_entered', 'merged'].includes(row.event)
    && typeof row.ts === 'string' && Number.isFinite(Date.parse(row.ts)));
}
