type Source = 'healthy' | 'degraded' | 'missing' | 'not-landed';
export interface RunsNow {
  v: 1; generatedAt: string;
  workers: Array<{ job: string }>;
  mergesLastHour: { count: number | null };
  codexPersonal: { usedPct: number | null; resetsAt: string | null; asOf: string | null } | null;
  leaders: Array<{ label: string; ageSeconds: number | null }>;
  sources: { workers: Source; merges: Source; codex: Source };
}
export interface RunsNowTile {
  id: 'workers' | 'merged' | 'codex' | 'leaders'; label: string; value: string; caption: string | null; degraded: boolean;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const source = (v: unknown): v is Source => v === 'healthy' || v === 'degraded' || v === 'missing' || v === 'not-landed';

export function readRunsNow(raw: unknown): RunsNow | null {
  if (!record(raw) || raw.v !== 1 || typeof raw.generatedAt !== 'string'
    || !Array.isArray(raw.workers) || !raw.workers.every(w => record(w) && typeof w.job === 'string')
    || !record(raw.mergesLastHour) || !(raw.mergesLastHour.count === null || (nonnegative(raw.mergesLastHour.count) && Number.isSafeInteger(raw.mergesLastHour.count)))
    || !(raw.codexPersonal === null || (record(raw.codexPersonal) && (raw.codexPersonal.usedPct === null || (nonnegative(raw.codexPersonal.usedPct) && raw.codexPersonal.usedPct <= 100)) && nullableString(raw.codexPersonal.resetsAt) && nullableString(raw.codexPersonal.asOf)))
    || !Array.isArray(raw.leaders) || !raw.leaders.every(l => record(l) && typeof l.label === 'string' && (l.ageSeconds === null || nonnegative(l.ageSeconds)))
    || !record(raw.sources) || !source(raw.sources.workers) || !source(raw.sources.merges) || !source(raw.sources.codex)) return null;
  return raw as unknown as RunsNow;
}

// Compact, deterministic relative time based on the supplied clock.
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
function instant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
export function runsNowTiles(input: RunsNow, nowMs: number): RunsNowTile[] {
  const codex = input.codexPersonal;
  const reset = instant(codex?.resetsAt ?? null);
  const asOf = instant(codex?.asOf ?? null);
  const resetCaption = reset !== null ? (reset > nowMs ? `resets in ${duration(reset - nowMs)}` : 'reset passed')
    : asOf !== null ? `as of ${duration(nowMs - asOf)} ago` : null;
  const ages = input.leaders.flatMap(l => l.ageSeconds === null ? [] : [l.ageSeconds]);
  const workerBad = input.sources.workers !== 'healthy';
  const mergeBad = input.sources.merges !== 'healthy';
  const codexBad = input.sources.codex !== 'healthy';
  return [
    { id: 'workers', label: 'Workers running', value: String(input.workers.length), caption: workerBad ? `worker list ${input.sources.workers}` : null, degraded: workerBad },
    { id: 'merged', label: 'Merged last hour', value: input.mergesLastHour.count === null ? '—' : String(input.mergesLastHour.count), caption: mergeBad ? `merges ${input.sources.merges}` : null, degraded: mergeBad },
    { id: 'codex', label: 'Personal Codex used', value: codex?.usedPct == null ? '—' : `${codex.usedPct}%`, caption: [resetCaption, codexBad ? `codex ${input.sources.codex}` : null].filter(Boolean).join(' · ') || null, degraded: codexBad },
    { id: 'leaders', label: 'Leader passes', value: String(input.leaders.length), caption: ages.length ? `newest ${duration(Math.min(...ages) * 1000)} ago` : 'no pass seen', degraded: false },
  ];
}
export function describeRunsNow(tiles: RunsNowTile[]): string {
  const [workers, merged, codex, leaders] = tiles;
  const spoken = (value: string) => value === '—' ? 'unknown' : value;
  return `Right now: ${spoken(workers!.value)} ${workers!.value === '1' ? 'worker' : 'workers'}, ${spoken(merged!.value)} merged last hour, personal Codex ${spoken(codex!.value)} used, ${spoken(leaders!.value)} leader ${leaders!.value === '1' ? 'pass' : 'passes'} (${leaders!.caption}).`;
}
