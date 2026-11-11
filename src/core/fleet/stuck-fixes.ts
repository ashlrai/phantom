/**
 * core/fleet/stuck-fixes.ts — which guardian FIXUP-MAIN jobs published a
 * pull request that never reached a terminal outcome? The pure fold behind
 * `ashlr fleet stuck-fixes` and `GET /api/verse/runs-history/stuck-fixes`.
 *
 * Source: the host metrics ledger `<runs>/metrics/jobs.jsonl`
 * (ASHLR_RUNS_DIR overrides ~/.ashlr-runs). A job whose id starts with
 * FIXUP-MAIN is stuck when some row carries a PR url, no row gives it a
 * terminal state (MERGED or CLOSED), and the newest dated PR row is older
 * than 20 minutes. Each stuck row names repo, PR url and age in minutes.
 *
 * The ledger read is injectable (`readFile`) so the report is fully testable.
 * An unreadable ledger is reported as `known:false` — never guessed as zero
 * stuck. Torn JSONL lines are skipped, not fatal. A PR url with no parseable
 * timestamp cannot prove age, so it is left out rather than guessed.
 *
 * `readStuckFixes` never throws and its payload carries no paths.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STUCK_FIX_MIN_AGE_MINUTES = 20;

export interface StuckFixRow {
  job: string;
  repo: string | null;
  prUrl: string;
  publishedAt: string;
  ageMinutes: number;
}

/** Wire shape of `GET /api/verse/runs-history/stuck-fixes` — no ledger path. */
export interface StuckFixesV1 {
  v: 1;
  generatedAt: string;
  known: boolean;
  thresholdMinutes: number;
  stuck: StuckFixRow[];
}

type Row = Record<string, unknown>;
const asRow = (v: unknown): Row | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : null;
const pick = (row: Row, ...names: string[]): string | null => {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};
const jobOf = (row: Row): string | null => pick(row, 'job', 'job_id', 'jobId', 'id');
const urlOf = (row: Row): string | null => {
  const url = pick(row, 'url', 'pr_url', 'prUrl', 'pr');
  return url !== null && /^https:\/\/\S+$/.test(url) ? url : null;
};
const tsOf = (row: Row): number | null => {
  const ts = pick(row, 'ts', 'timestamp', 'at', 'publishedAt', 'published_at');
  const ms = ts === null ? Number.NaN : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
};
const TERMINAL = new Set(['MERGED', 'CLOSED']);
const phaseOf = (row: Row): string => (pick(row, 'state', 'outcome', 'status') ?? '').toUpperCase();
const ID_REPO = /^FIXUP-MAIN-(.+)-[0-9a-f]{7,40}$/i;
const URL_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9]\d*/;

/** Repo from the FIXUP-MAIN-<repo>-<sha> id, else the pull url's owner/name. */
const repoFor = (job: string, prUrl: string, fromRows: string | null): string | null =>
  fromRows ?? ID_REPO.exec(job)?.[1] ?? URL_REPO.exec(prUrl)?.[1] ?? null;

/** Fold the ledger into stuck FIXUP-MAIN rows; malformed lines are skipped. */
export function findStuckFixes(text: string, nowMs: number,
  thresholdMinutes = STUCK_FIX_MIN_AGE_MINUTES): { rows: number; stuck: StuckFixRow[] } {
  interface Acc { repo: string | null; urlMs: number; prUrl: string; terminal: boolean }
  const jobs = new Map<string, Acc>();
  let rows = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let row: Row | null;
    try { row = asRow(JSON.parse(line)); } catch { continue; }
    if (!row) continue;
    rows++;
    const job = jobOf(row);
    if (job === null || !job.startsWith('FIXUP-MAIN')) continue;
    const acc = jobs.get(job) ?? { repo: null, urlMs: -Infinity, prUrl: '', terminal: false };
    acc.repo ??= pick(row, 'repo', 'repository');
    if (TERMINAL.has(phaseOf(row))) acc.terminal = true;
    const url = urlOf(row);
    const ms = tsOf(row);
    // The newest dated url names the current PR and its publish time.
    if (url !== null && ms !== null && ms >= acc.urlMs) {
      acc.urlMs = ms;
      acc.prUrl = url;
    }
    jobs.set(job, acc);
  }
  const stuck: StuckFixRow[] = [];
  for (const [job, acc] of jobs) {
    if (acc.terminal || acc.prUrl === '') continue;
    const ageMs = nowMs - acc.urlMs;
    if (!(ageMs > thresholdMinutes * 60_000)) continue;
    stuck.push({
      job,
      repo: repoFor(job, acc.prUrl, acc.repo),
      prUrl: acc.prUrl,
      publishedAt: new Date(acc.urlMs).toISOString(),
      ageMinutes: Math.floor(ageMs / 60_000),
    });
  }
  stuck.sort((a, b) => b.ageMinutes - a.ageMinutes || a.job.localeCompare(b.job));
  return { rows, stuck };
}

/** The stuck-fixes verdict over `<runsDir>/metrics/jobs.jsonl`; never throws. */
export async function readStuckFixes(opts: {
  runsDir?: string;
  now?: () => number;
  readFile?: (p: string) => Promise<string>;
} = {}): Promise<StuckFixesV1> {
  const now = (opts.now ?? Date.now)();
  const root = opts.runsDir ?? (process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'));
  const read = opts.readFile ?? ((p: string) => readFile(p, 'utf8'));
  let text: string | null;
  try { text = await read(join(root, 'metrics', 'jobs.jsonl')); } catch { text = null; }
  const parsed = text === null ? null : findStuckFixes(text, now);
  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    known: parsed !== null,
    thresholdMinutes: STUCK_FIX_MIN_AGE_MINUTES,
    stuck: parsed?.stuck ?? [],
  };
}
