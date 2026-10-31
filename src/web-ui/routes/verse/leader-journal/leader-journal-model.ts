import { etaText, LEADER_PASS_CADENCE_MS, nextPassEta } from '../fleet/next-pass-eta.js';

/** Local wire contract for the independently delivered leader-journal endpoint. */
export interface JournalSection { title: string; bullets: string[] }
export interface LeaderNote { at: string; bullets: string[] }
export interface JournalPass { at: string; sections: JournalSection[] }
export interface DropIngestRow { verb: string; file: string; reason: string | null }
export interface DropIngestedRow { at: string; id: string; leader: string; lane: string; tier: string; title: string }
export interface LeaderJournalV1 {
  v: 1;
  generatedAt: string;
  sources: Record<'planLog' | 'ingestLog' | 'ingested' | 'orchestration', 'healthy' | 'missing' | 'degraded'>;
  notes: LeaderNote[];
  passes: JournalPass[];
  ingest: DropIngestRow[];
  ingested: DropIngestedRow[];
  rejectedLastHour: number | null;
}

export function passSchedule(passes: readonly JournalPass[], nowMs: number): {
  lastAtMs: number | null;
  eta: ReturnType<typeof nextPassEta> | null;
  text: string;
  tone: 'ok' | 'warning' | 'danger';
} {
  if (passes.length === 0) return { lastAtMs: null, eta: null, text: 'no pass recorded yet', tone: 'warning' };
  const times = passes.map((pass) => Date.parse(pass.at)).filter(Number.isFinite);
  const lastAtMs = times.length ? Math.max(...times) : null;
  const eta = nextPassEta(lastAtMs, nowMs, LEADER_PASS_CADENCE_MS);
  const tone = eta.kind === 'due-in' ? 'ok'
    : eta.kind === 'overdue' && lastAtMs !== null && nowMs - lastAtMs - LEADER_PASS_CADENCE_MS > 30 * 60_000 ? 'danger' : 'warning';
  return { lastAtMs, eta, text: etaText(eta), tone };
}

type Check<T> = (value: unknown) => value is T;
const string: Check<string> = (value): value is string => typeof value === 'string';
const array = <T>(check: Check<T>): Check<T[]> => (value): value is T[] => Array.isArray(value) && value.every(check);
const nullable = <T>(check: Check<T>): Check<T | null> => (value): value is T | null => value === null || check(value);
function shape<S extends Record<string, Check<unknown>>>(schema: S): Check<{ [K in keyof S]: S[K] extends Check<infer T> ? T : never }> {
  return (value): value is { [K in keyof S]: S[K] extends Check<infer T> ? T : never } =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(schema).every(([key, check]) => check((value as Record<string, unknown>)[key]));
}
const source: Check<'healthy' | 'missing' | 'degraded'> = (value): value is 'healthy' | 'missing' | 'degraded' =>
  value === 'healthy' || value === 'missing' || value === 'degraded';
const count: Check<number> = (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
export const isLeaderJournal: Check<LeaderJournalV1> = shape({
  v: (value): value is 1 => value === 1,
  generatedAt: string,
  sources: shape({ orchestration: source, planLog: source, ingestLog: source, ingested: source }),
  notes: array(shape({ at: string, bullets: array(string) })),
  passes: array(shape({ at: string, sections: array(shape({ title: string, bullets: array(string) })) })),
  ingest: array(shape({ verb: string, file: string, reason: nullable(string) })),
  ingested: array(shape({ at: string, id: string, leader: string, lane: string, tier: string, title: string })),
  rejectedLastHour: nullable(count),
});

export function passSummary(pass: JournalPass): string {
  return (pass.sections[0]?.bullets[0] ?? '').trim().slice(0, 120);
}
export function ingestTone(row: DropIngestRow): 'bad' | 'neutral' {
  return /^reject(?:ed)?$/i.test(row.verb) ? 'bad' : 'neutral';
}
export function groupRejects(rows: readonly DropIngestRow[]): Record<string, number> {
  const groups: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const row of rows) {
    if (ingestTone(row) !== 'bad') continue;
    const reason = row.reason ?? 'unknown reason';
    groups[reason] = (groups[reason] ?? 0) + 1;
  }
  return groups;
}

export function filterPasses(passes: readonly JournalPass[], query: string): Array<{ pass: JournalPass; matchedBullets: Set<string> }> {
  const needle = query.trim().toLowerCase();
  return passes.flatMap((pass) => {
    const matchedBullets = new Set<string>();
    let matched = !needle;
    for (const section of pass.sections) {
      if (needle && section.title.toLowerCase().includes(needle)) matched = true;
      for (const bullet of section.bullets) {
        if (needle && bullet.toLowerCase().includes(needle)) { matched = true; matchedBullets.add(bullet); }
      }
    }
    return matched ? [{ pass, matchedBullets }] : [];
  });
}
export function passFilterLabel(shown: number, total: number): string {
  return shown === total ? '' : `${shown} of ${total} passes`;
}

export function filterNotes(notes: readonly LeaderNote[], query: string): LeaderNote[] {
  return filterPasses(notes.map(note => ({ at: note.at, sections: [{ title: '', bullets: note.bullets }] })), query)
    .map(({ pass }) => ({ at: pass.at, bullets: pass.sections[0].bullets }));
}
