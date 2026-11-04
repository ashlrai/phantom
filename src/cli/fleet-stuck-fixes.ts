/**
 * `ashlr fleet stuck-fixes` — read-only: which guardian FIXUP-MAIN jobs
 * published a pull request that never reached a terminal outcome?
 *
 * Source: the host metrics ledger `<runs>/metrics/jobs.jsonl`
 * (ASHLR_RUNS_DIR overrides ~/.ashlr-runs). A job whose id starts with
 * FIXUP-MAIN is stuck when some row carries a PR url, no row gives it a
 * terminal state (MERGED or CLOSED), and the newest dated PR row is older
 * than 20 minutes. Each stuck row names repo, PR url and age in minutes.
 *
 * The fold lives in core/fleet/stuck-fixes.ts (shared with
 * `GET /api/verse/runs-history/stuck-fixes`); the ledger read here is
 * injected (`readFile`) so the report is fully testable. An unreadable
 * ledger is reported as `known:false` — never guessed as zero stuck.
 * Torn JSONL lines are skipped, not fatal. A PR url with no parseable
 * timestamp cannot prove age, so it is left out rather than guessed.
 *
 * Exit codes: 0 ledger read, 1 ledger unread, 2 bad usage.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findStuckFixes, STUCK_FIX_MIN_AGE_MINUTES, type StuckFixRow } from '../core/fleet/stuck-fixes.js';

export { findStuckFixes, STUCK_FIX_MIN_AGE_MINUTES };
export type { StuckFixRow };

export const FLEET_STUCK_FIXES_USAGE = 'ashlr fleet stuck-fixes [--jobs <file>] [--json]';

const runsHome = (): string => process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs');

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetStuckFixesDeps {
  now?: () => Date;
  output?: Output;
  readFile?: (path: string) => string;
}

export interface FleetStuckFixesReport {
  v: 1;
  generatedAt: string;
  known: boolean;
  path: string;
  thresholdMinutes: number;
  rows: number;
  stuck: StuckFixRow[];
}

export async function cmdFleetStuckFixes(args: string[], deps: FleetStuckFixesDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  let path = join(runsHome(), 'metrics', 'jobs.jsonl');
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output.log(FLEET_STUCK_FIXES_USAGE); return 0; }
    if (seen.has(arg)) { output.error(`error: duplicate option\nusage: ${FLEET_STUCK_FIXES_USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--jobs') {
      const value = args[++i];
      if (!value) { output.error(`error: --jobs needs a file\nusage: ${FLEET_STUCK_FIXES_USAGE}`); return 2; }
      path = value;
    } else if (arg === '--json') json = true;
    else { output.error(`error: invalid argument\nusage: ${FLEET_STUCK_FIXES_USAGE}`); return 2; }
  }
  const now = (deps.now ?? (() => new Date()))();
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let text: string | null;
  try { text = readFile(path); } catch { text = null; }
  const parsed = text === null ? null : findStuckFixes(text, now.getTime());
  const report: FleetStuckFixesReport = {
    v: 1,
    generatedAt: now.toISOString(),
    known: parsed !== null,
    path,
    thresholdMinutes: STUCK_FIX_MIN_AGE_MINUTES,
    rows: parsed?.rows ?? 0,
    stuck: parsed?.stuck ?? [],
  };
  if (json) output.log(JSON.stringify(report));
  else if (parsed === null) output.error(`unread jobs ledger: ${path}`);
  else if (!report.stuck.length) output.log('no stuck FIXUP-MAIN pull requests');
  else for (const s of report.stuck) output.log(`${s.repo ?? 'unknown'}\t${s.ageMinutes} min\t${s.prUrl}\t${s.job}`);
  return report.known ? 0 : 1;
}
