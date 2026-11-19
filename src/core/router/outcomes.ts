import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Read-only recorded job outcomes from <runs>/metrics/jobs.jsonl. Recovered from the
// router-outcome slice of #6794 (head f9e484e87ec2). Scope is deliberately bounded:
// no routing, ranking, tuning, weights, or network. `passk` is omitted (always null);
// the pass^k lane-score join is not recovered here.

export const ROUTER_OUTCOME_LEDGER_LIMIT = 16 * 1024 * 1024;
export const ROUTER_OUTCOME_LEDGER_RELATIVE = join('metrics', 'jobs.jsonl');

export interface RouterOutcome {
  schema: 'router.outcome.v1';
  job_id: string;
  lane: string | null;
  model: string | null;
  tier: string | null;
  work_class: string | null;
  /** true only on an explicit MERGED state or merged:true; false on CLOSED or merged:false; else null. */
  merged: boolean | null;
  ci_first_pass: boolean | null;
  review_findings: { fixed: number; rejected: number; ignored: number } | null;
  cost_usd: number | null;
  wall_s: number | null;
  /** Always null in this slice: the pass^k score join was not recovered (see header). */
  passk: null;
}

export type LedgerReadState = 'read' | 'missing' | 'unreadable' | 'not-file' | 'too-large';

export type LedgerRead = { state: 'read'; text: string } | { state: Exclude<LedgerReadState, 'read'> };

/**
 * Bounded read of one regular file. O_NOFOLLOW refuses a symlink at the final path
 * component (reported as 'unreadable'); only ENOENT is 'missing'. Anything past `limit`
 * bytes is 'too-large', never truncated and parsed.
 */
export async function readLedgerFile(path: string, limit = ROUTER_OUTCOME_LEDGER_LIMIT): Promise<LedgerRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: 'not-file' };
    if (stat.size > limit) return { state: 'too-large' };
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > limit ? { state: 'too-large' } : { state: 'read', text: bytes.subarray(0, length).toString('utf8') };
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close();
  }
}

type Row = Record<string, unknown>;
const str = (r: Row, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;

export interface RouterOutcomeFold {
  outcomes: RouterOutcome[];
  /** Non-blank lines that were not a JSON object. Skipped, never attached. */
  malformed_rows: number;
  /** Rows with no job identity that could not be attached. */
  unattached_rows: number;
  /** PR URLs claimed by more than one job; URL-only rows for them are not attached to any job. */
  ambiguous_urls: number;
}

/** Folds JSONL text into one outcome per job. Explicit fields only; nothing inferred. */
export function foldRouterOutcomes(text: string): RouterOutcomeFold {
  const rows: Row[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) rows.push(value as Row);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  const jobId = (r: Row) => str(r, 'job', 'job_id', 'jobId', 'id');
  const prUrl = (r: Row) => str(r, 'url', 'pr_url', 'prUrl', 'pr');

  // A PR URL resolves to a job only when exactly one job claims it.
  const claims = new Map<string, Set<string>>();
  for (const r of rows) {
    const j = jobId(r), u = prUrl(r);
    if (j && u) claims.set(u, (claims.get(u) ?? new Set()).add(j));
  }
  const ambiguous = new Set([...claims].filter(([, jobs]) => jobs.size > 1).map(([u]) => u));
  const urlToJob = new Map([...claims].filter(([u, jobs]) => !ambiguous.has(u) && jobs.size === 1)
    .map(([u, jobs]) => [u, [...jobs][0]!] as const));

  const outcomes = new Map<string, RouterOutcome>();
  const mergedAt = new Map<string, number>();
  let unattached = 0;
  for (const r of rows) {
    const u = prUrl(r);
    const j = jobId(r) ?? (u ? urlToJob.get(u) : undefined);
    if (!j) { unattached++; continue; }
    const o: RouterOutcome = outcomes.get(j) ?? {
      schema: 'router.outcome.v1', job_id: j, lane: null, model: null, tier: null, work_class: null,
      merged: null, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null, passk: null,
    };
    o.lane = str(r, 'lane', 'pool', 'arm') ?? o.lane;
    o.model = str(r, 'model') ?? o.model;
    o.tier = str(r, 'tier') ?? o.tier;
    o.work_class = str(r, 'work_class') ?? o.work_class;
    const state = (str(r, 'phase', 'state', 'outcome', 'status') ?? '').toUpperCase();
    const merged = state === 'MERGED' ? true : state === 'CLOSED' ? false : typeof r['merged'] === 'boolean' ? r['merged'] : null;
    if (merged !== null) {
      const ts = Date.parse(str(r, 'ts', 'timestamp', 'at', 'mergedAt', 'closedAt') ?? '') || 0;
      if (ts >= (mergedAt.get(j) ?? -1)) { o.merged = merged; mergedAt.set(j, ts); }
    }
    if (typeof r['ci_first_pass'] === 'boolean') o.ci_first_pass = r['ci_first_pass'];
    o.cost_usd = num(r['cost_usd']) ?? o.cost_usd;
    o.wall_s = num(r['wall_s']) ?? o.wall_s;
    const f = r['review_findings'];
    if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
      const fixed = count((f as Row)['fixed']), rejected = count((f as Row)['rejected']), ignored = count((f as Row)['ignored']);
      if (fixed !== null && rejected !== null && ignored !== null) o.review_findings = { fixed, rejected, ignored };
    }
    outcomes.set(j, o);
  }
  return {
    outcomes: [...outcomes.values()],
    malformed_rows: malformed,
    unattached_rows: unattached,
    ambiguous_urls: ambiguous.size,
  };
}

export interface RouterOutcomeRead extends RouterOutcomeFold {
  /** 'read' is the only state with trustworthy outcomes; everything else is an unknown ledger. */
  state: LedgerReadState;
  path: string;
}

/**
 * Reads <runsDir>/metrics/jobs.jsonl. `runsDir` defaults to ASHLR_RUNS_DIR, then ~/.ashlr-runs,
 * and must be absolute when given. A missing or unreadable ledger yields state != 'read' with
 * no outcomes, so callers can tell unknown input from a successfully read empty ledger.
 */
export async function readRouterOutcomes(opts: { runsDir?: string; lane?: string } = {}): Promise<RouterOutcomeRead> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new RangeError('runsDir must be an absolute path');
  const path = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const read = await readLedgerFile(path);
  const empty: RouterOutcomeFold = { outcomes: [], malformed_rows: 0, unattached_rows: 0, ambiguous_urls: 0 };
  if (read.state !== 'read') return { ...empty, state: read.state, path };
  const folded = foldRouterOutcomes(read.text);
  const outcomes = opts.lane === undefined ? folded.outcomes : folded.outcomes.filter(o => o.lane === opts.lane);
  return { ...folded, outcomes, state: 'read', path };
}
