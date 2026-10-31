/** Local wire contract: no dependency on the independently landing backend. */
type Check<T> = (value: unknown) => value is T;
const str: Check<string> = (v): v is string => typeof v === 'string';
const num: Check<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v);
const bool: Check<boolean> = (v): v is boolean => typeof v === 'boolean';
const nullable = <T>(check: Check<T>): Check<T | null> => (v): v is T | null => v === null || check(v);
const array = <T>(check: Check<T>): Check<T[]> => (v): v is T[] => Array.isArray(v) && v.every(check);
function shape<S extends Record<string, Check<unknown>>>(schema: S): Check<{ [K in keyof S]: S[K] extends Check<infer T> ? T : never }> {
  return (v): v is { [K in keyof S]: S[K] extends Check<infer T> ? T : never } =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.entries(schema).every(([key, check]) => check((v as Record<string, unknown>)[key]));
}
const n = nullable(num);
const s = nullable(str);
const source: Check<'healthy' | 'degraded' | 'missing' | 'not-landed'> = (v): v is 'healthy' | 'degraded' | 'missing' | 'not-landed' =>
  v === 'healthy' || v === 'degraded' || v === 'missing' || v === 'not-landed';
export const isFleetRuns = shape({
  v: ((v): v is 1 => v === 1), generatedAt: str,
  sources: shape({ runsDir: source, workers: source, inbox: source, codex: source, merges: source }),
  lastTick: s, paused: nullable(bool), memFreePct: n, diskFreeGb: n, switches: array(str), claudeLane: s,
  lanes: array(shape({ lane: str, running: num, target: num, queued: num, held: bool, heldReason: s, tokensLastHour: n, merged24h: n, mergeRate24h: n })),
  workers: array(shape({ job: str, repo: str, lane: str, tier: str, ageSeconds: n })),
  leaders: array(shape({ label: str, ageSeconds: n })), orchestratorAgents: n,
  publishesLastHour: array(shape({ job: str, lane: s, url: s, at: str })),
  mergesLastHour: shape({ count: n, items: array(shape({ repo: str, number: num, title: str })) }),
  events: array(shape({ at: str, kind: str, text: str })),
  codexPersonal: nullable(shape({ usedPct: n, resetsAt: s, asOf: s })),
  inbox: array(shape({ at: str, source: str, text: str })),
  drop: nullable(shape({ pending: array(shape({ lane: str, file: str })), done: num })),
});
export type FleetRuns = typeof isFleetRuns extends Check<infer T> ? T : never;
export const countText = (n: number | null): string => n === null ? '—' : String(n);
export function ageText(seconds: number | null): string {
  if (seconds === null) return '—';
  const t = Math.max(0, Math.floor(seconds));
  return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`
    : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
export function relativeText(at: string | null, now: number): string {
  if (at === null || !Number.isFinite(Date.parse(at))) return '—';
  const minutes = Math.round((Date.parse(at) - now) / 60_000);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(minutes, 'minute');
}
export const newest = <T extends { at: string }>(rows: T[], limit: number): T[] =>
  [...rows].sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || b.at.localeCompare(a.at)).slice(0, limit);
