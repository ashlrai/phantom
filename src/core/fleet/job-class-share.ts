/** Pure, read-only projection of supervisor metrics/jobs.jsonl. */
export type JobShareClass = 'author' | 'drain' | 'real';
export interface JobClassShareRow {
  lane: string;
  jobs: number;
  tokens: number;
  author_pct: number | null;
  drain_pct: number | null;
  real_pct: number | null;
}
export interface JobClassShareReport {
  schema: 'fleet.job-class-share.v1';
  hours: number;
  generatedAt: string;
  malformed: number;
  rows: JobClassShareRow[];
}

const AUTHOR = /^RQ-(?:LOCUS|LEXICON|MD|STACK|PLUGIN|PS)\d+A\d{6}Q8$/;
const CLASS_KEYS: readonly JobShareClass[] = ['author', 'drain', 'real'];

/** Auto-authored filler and maintenance drains vs real work, by job id. */
export function classifyJobShare(id: string): JobShareClass {
  if (AUTHOR.test(id)) return 'author';
  if (id.startsWith('RQ-DRAIN-') || id.startsWith('RQ-LAND')) return 'drain';
  return 'real';
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);

/** Only finish events inside [now-hours, now] contribute. A finish with a null or
 * invalid tokens_total counts as a job with zero known tokens. Earlier rows supply
 * lanes for finish rows that omit them; repeated finishes keep the latest total.
 */
export function jobClassShare(input: string | readonly unknown[], hours = 6, now = Date.now()): JobClassShareReport {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(now)) throw new Error('Invalid reporting window');
  const rows: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const value of typeof input === 'string' ? input.split(/\r?\n/).filter(line => line.trim()) : input) {
    let row: unknown = value;
    if (typeof value === 'string') {
      try { row = JSON.parse(value); } catch { malformed++; continue; }
    }
    if (!object(row) || !identifier(row.job ?? row.job_id ?? row.id) || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) || typeof row.event !== 'string' || (row.lane !== undefined && !identifier(row.lane))) {
      malformed++; continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => Date.parse(a.ts as string) - Date.parse(b.ts as string));
  const lanes = new Map<string, string>();
  const perLane = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const id = String(row.job ?? row.job_id ?? row.id);
    const at = Date.parse(row.ts as string);
    if (at > now) continue;
    if (identifier(row.lane)) lanes.set(id, row.lane);
    const lane = (row.lane as string | undefined) ?? lanes.get(id);
    if (!lane || row.event !== 'finish' || at < now - hours * 3_600_000) continue;
    let jobs = perLane.get(lane);
    if (!jobs) perLane.set(lane, jobs = new Map());
    jobs.set(id, typeof row.tokens_total === 'number' && Number.isSafeInteger(row.tokens_total) && row.tokens_total >= 0 ? row.tokens_total : 0);
  }
  const pct = (part: number, whole: number): number | null => whole > 0 ? Math.round(part / whole * 1000) / 10 : null;
  const laneRows: JobClassShareRow[] = [];
  const total: JobClassShareRow = { lane: 'total', jobs: 0, tokens: 0, author_pct: null, drain_pct: null, real_pct: null };
  const totalByClass: Record<JobShareClass, number> = { author: 0, drain: 0, real: 0 };
  for (const [lane, jobs] of [...perLane.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const byClass: Record<JobShareClass, number> = { author: 0, drain: 0, real: 0 };
    let tokens = 0;
    for (const [id, jobTokens] of jobs) {
      byClass[classifyJobShare(id)] += jobTokens;
      tokens += jobTokens;
    }
    total.jobs += jobs.size;
    total.tokens += tokens;
    for (const key of CLASS_KEYS) totalByClass[key] += byClass[key];
    laneRows.push({ lane, jobs: jobs.size, tokens, author_pct: pct(byClass.author, tokens), drain_pct: pct(byClass.drain, tokens), real_pct: pct(byClass.real, tokens) });
  }
  total.author_pct = pct(totalByClass.author, total.tokens);
  total.drain_pct = pct(totalByClass.drain, total.tokens);
  total.real_pct = pct(totalByClass.real, total.tokens);
  return { schema: 'fleet.job-class-share.v1', hours, generatedAt: new Date(now).toISOString(), malformed, rows: [...laneRows, total] };
}
