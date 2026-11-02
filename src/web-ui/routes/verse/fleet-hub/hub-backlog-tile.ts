type Tone = 'ok' | 'warn' | 'neutral';
type Tile = { text: string; detail: string; tone: Tone; stale: boolean };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const actions = ['recut', 'merge', 'refresh', 'wait', 'none'] as const;

/** Only display a complete, understood snapshot; never turn bad data into zeroes. */
export function backlogTile(read: unknown, nowMs: number): Tile | null {
  if (!record(read) || read.v !== 1 || (read.source !== 'ok' && read.source !== 'gh-failed')
    || typeof read.generatedAt !== 'string' || !Number.isFinite(Date.parse(read.generatedAt))
    || !Number.isFinite(nowMs) || !Array.isArray(read.items) || !record(read.counts)
    || !record(read.counts.mergeState) || !record(read.counts.actions)
    || !Object.entries(read.counts.mergeState).every(([key, value]) => /^[A-Z_]+$/.test(key) && count(value))) return null;
  const actionCounts = read.counts.actions;
  if (!actions.every(action => count(actionCounts[action]))) return null;

  const age = Math.max(0, nowMs - Date.parse(read.generatedAt));
  const minutes = Math.floor(age / 60_000);
  const ageText = minutes === 0 ? 'read just now' : `read ${minutes} min ago`;
  const stale = age > 15 * 60_000;
  if (read.source === 'gh-failed') {
    const reason = typeof read.reason === 'string' && /^[a-z0-9-]{1,80}$/.test(read.reason) ? read.reason : 'unknown';
    return { text: `GitHub read failed · ${reason}`, detail: ageText, tone: 'neutral', stale };
  }
  const states = read.counts.mergeState as Record<string, number>;
  const planned = read.counts.actions as Record<typeof actions[number], number>;
  const stateText = Object.entries(states).filter(([, value]) => value > 0)
    .sort(([a, av], [b, bv]) => bv - av || a.localeCompare(b))
    .map(([state, value]) => `${state} ${value}`);
  const actionText = actions.filter(action => planned[action] > 0).map(action => `${action} ${planned[action]}`);
  return {
    text: [`${read.items.length} open`, ...stateText].join(' · '),
    detail: [...(actionText.length ? actionText : ['no actions']), ageText].join(' · '),
    tone: (states.DIRTY ?? 0) >= 5 || planned.recut >= 5 ? 'warn' : 'ok',
    stale,
  };
}
