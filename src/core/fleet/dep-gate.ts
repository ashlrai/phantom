/**
 * Ready-row dependency gate (RQ-DEPGATEQ8). Read-only check: every non-PARKED
 * ready.tsv row whose prompt declares `DEPENDENCY GATE: <ids>` must find a
 * MERGED outcome row in metrics/jobs.jsonl for each id. Complements the
 * PARKED-DEP `unmetDeps` projection in runs-parked-queue — parked rows are
 * expected to wait; this gate covers rows that are still queued to launch.
 */
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { KNOWN_STATUSES } from './lane-console.js';
import {
  mergedJobsFromJsonl,
  parseDependencyGateIds,
  readSource,
  type Source,
} from './runs-parked-queue.js';

/** A queued row whose DEPENDENCY GATE ids are not all MERGED. */
export interface DepGateUnmet { job: string; lane: string | null; unmet: string[] }
export interface DepGateReport {
  v: 1;
  generatedAt: string;
  sources: Record<'ready' | 'jobs', Source>;
  /** Non-parked rows carrying a prompt column. */
  rows: number;
  /** Rows whose prompt declares at least one DEPENDENCY GATE id. */
  gated: number;
  /** Gated rows with at least one id missing a MERGED outcome. */
  unmet: DepGateUnmet[];
}

const MAX_READY = 2 * 1024 * 1024;
const MAX_JOBS_JSONL = 2 * 1024 * 1024;
const MAX_PROMPT = 64 * 1024;
const MAX_ROWS = 50_000;
const PARKED = /^PARKED/i;

/** --runs-dir, then ASHLR_RUNS_DIR, then ~/.ashlr-runs — the fleet convention. */
export function depGateRunsDir(explicit?: string): string {
  return explicit ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

/** Prompt paths stay inside the runs root, matching the parked queue reader. */
function promptPath(root: string, cell: string): string | null {
  const rootAbs = resolve(root);
  const abs = resolve(cell.startsWith('/') ? cell : join(rootAbs, 'queue', cell));
  return abs === rootAbs || abs.startsWith(rootAbs + sep) ? abs : null;
}

interface ReadyRow { job: string; lane: string; promptCell: string }

/**
 * Both ready.tsv layouts keep the lane in column 3: the dispatcher layout is
 * `job, repo, lane, tier, prompt` (prompt column 5) and the status-first
 * layout is `status, job, lane, tier, repo, prompt` (prompt column 6). Rows
 * whose status or lane cell starts with PARKED are skipped — parked rows are
 * reported by `fleet parked` unmetDeps instead.
 */
function readyRow(line: string): ReadyRow | null {
  const cells = line.split('\t');
  const first = cells[0] ?? '';
  const lane = cells[2] ?? '';
  if (PARKED.test(first) || PARKED.test(lane)) return null;
  const statusFirst = KNOWN_STATUSES.has(first.toUpperCase());
  const job = statusFirst ? cells[1] : first;
  const promptCell = cells[statusFirst ? 5 : 4];
  if (!job || !lane || !promptCell) return null;
  return { job, lane, promptCell };
}

export async function readDepGate(opts: { runsDir?: string; now?: () => number } = {}): Promise<DepGateReport> {
  const now = (opts.now ?? Date.now)();
  const root = depGateRunsDir(opts.runsDir);
  const [readySource, jobsSource] = await Promise.all([
    readSource(join(root, 'queue', 'ready.tsv'), MAX_READY, false),
    readSource(join(root, 'metrics', 'jobs.jsonl'), MAX_JOBS_JSONL, true),
  ]);
  const merged = mergedJobsFromJsonl(jobsSource.text);
  const rows: ReadyRow[] = [];
  for (const raw of readySource.text.split('\n')) {
    if (rows.length >= MAX_ROWS) break;
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const row = readyRow(line);
    if (row) rows.push(row);
  }
  const unmet: DepGateUnmet[] = [];
  let gated = 0;
  for (const row of rows) {
    const abs = promptPath(root, row.promptCell);
    if (!abs) continue;
    const prompt = await readSource(abs, MAX_PROMPT, false);
    if (prompt.state !== 'healthy') continue;
    const ids = parseDependencyGateIds(prompt.text);
    if (ids.length === 0) continue;
    gated++;
    const missing = ids.filter((id) => !merged.has(id));
    if (missing.length > 0) unmet.push({ job: row.job, lane: row.lane, unmet: missing });
  }
  return {
    v: 1, generatedAt: new Date(now).toISOString(),
    sources: { ready: readySource.state, jobs: jobsSource.state },
    rows: rows.length, gated, unmet,
  };
}
