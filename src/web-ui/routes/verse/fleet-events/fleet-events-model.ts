export interface FeedItem { id: string; at: string; kind: string; text: string; url: string | null }
export interface Leader { label: string; ageSeconds: number | null }
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function sortNewestFirst(items: readonly FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const x = Date.parse(a.at), y = Date.parse(b.at);
    return (Number.isFinite(y) ? y : -Infinity) - (Number.isFinite(x) ? x : -Infinity) || 0;
  });
}
export function filterByKinds(items: readonly FeedItem[], kinds: ReadonlySet<string>): FeedItem[] {
  return kinds.size ? items.filter(item => kinds.has(item.kind)) : [...items];
}
export function filterByText(items: readonly FeedItem[], text: string): FeedItem[] {
  const needle = text.trim().toLocaleLowerCase();
  return needle ? items.filter(item => item.text.toLocaleLowerCase().includes(needle) || item.kind.toLocaleLowerCase().includes(needle)) : [...items];
}
export function diffNew(previousIds: ReadonlySet<string>, items: readonly FeedItem[]): FeedItem[] {
  return items.filter(item => !previousIds.has(item.id));
}
export function readFeed(snapshot: unknown) {
  const data = record(snapshot), drop = record(data.drop), sources = record(data.sources);
  const items: FeedItem[] = [], occurrences = new Map<string, number>();
  for (const raw of Array.isArray(data.events) ? data.events : []) {
    const e = record(raw);
    if (typeof e.at !== 'string' || typeof e.kind !== 'string' || typeof e.text !== 'string') continue;
    const key = JSON.stringify(['event', e.at, e.kind, e.text]);
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    items.push({ id: `${key}:${n}`, at: e.at, kind: e.kind, text: e.text, url: null });
  }
  for (const raw of Array.isArray(data.publishesLastHour) ? data.publishesLastHour : []) {
    const p = record(raw);
    if (typeof p.at !== 'string' || typeof p.job !== 'string') continue;
    items.push({ id: JSON.stringify(['publish', p.job, p.at]), at: p.at, kind: 'publish', text: p.job, url: typeof p.url === 'string' ? p.url : null });
  }
  const leaders: Leader[] = (Array.isArray(data.leaders) ? data.leaders : []).flatMap(raw => {
    const leader = record(raw);
    return typeof leader.label === 'string' ? [{ label: leader.label, ageSeconds: count(leader.ageSeconds) }] : [];
  });
  return { items: sortNewestFirst(items), leaders, agents: count(data.orchestratorAgents),
    pending: Array.isArray(drop.pending) ? drop.pending.length : null, done: count(drop.done),
    sourceState: typeof sources.runsDir === 'string' ? sources.runsDir : null };
}
export function summarizeKinds(items: readonly FeedItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => count + ' ' + (kind + (kind.endsWith('s') ? '' : 's')))
    .join(' · ');
}
