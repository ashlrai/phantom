/**
 * Read-only: how long has each repo's default branch been red?
 * Reads the main guardian's per-repo state file
 * (~/.ashlr-runs/guardian/state.json; ASHLR_RUNS_DIR overrides the root):
 *   {"owner/repo": {"state":"red","red_first":"<ISO>","red_since":"<ISO>",
 *                   "attempts":2,"cur_job":"RQ-1"}, ...}
 * A top-level {"repos": {...}} wrapper is accepted too. Minutes red come from
 * red_first when present, else red_since. A state file that cannot be read
 * leaves every answer "unknown"; it is never guessed.
 *
 * The parse and projection live in core/fleet/main-red-age.ts — the same
 * logic `GET /api/verse/fleet/main-red-age` serves — so `main-red-age --json`
 * and the typed route never disagree. They are re-exported here for the
 * callers and tests written against this path.
 */
import { readFileSync } from 'node:fs';
import {
  buildMainRedAge,
  defaultStatePath,
  parseGuardianState,
} from '../core/fleet/main-red-age.js';

export { buildMainRedAge, parseGuardianState };
export type { MainRedAgeReport, RedAgeRow } from '../core/fleet/main-red-age.js';

const USAGE = 'usage: ashlr fleet main-red-age [--state <file>] [--json]';

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetMainRedAgeDeps { now?: () => Date; output?: Output; readFile?: (path: string) => string }

export async function cmdFleetMainRedAge(args: string[], deps: FleetMainRedAgeDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  let statePath = defaultStatePath();
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output.log(USAGE); return 0; }
    if (seen.has(arg)) { output.error(`error: duplicate option\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--state') {
      const value = args[++i];
      if (!value) { output.error(`error: --state needs a file\n${USAGE}`); return 2; }
      statePath = value;
    } else if (arg === '--json') json = true;
    else { output.error(`error: invalid argument\n${USAGE}`); return 2; }
  }
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const now = (deps.now ?? (() => new Date()))();
  let raw: string | null = null;
  try { raw = readFile(statePath); } catch { /* missing or unreadable stays unknown */ }
  const state = raw === null ? null : parseGuardianState(raw);
  const report = buildMainRedAge(state, now, statePath);
  if (raw !== null && state === null) report.source.status = 'invalid';
  if (json) output.log(JSON.stringify(report));
  else if (report.source.status === 'read') {
    if (!report.repos.length) output.log('no repos in the guardian state');
    for (const r of report.repos) {
      output.log(`${r.repo}\t${r.state}\tred ${r.redMinutes ?? 'unknown'} min\tattempts ${r.attempts ?? 'unknown'}\tjob ${r.currentJob ?? 'none'}`);
    }
  } else {
    output.log('unknown');
    output.error(`${report.source.status} guardian state: ${report.source.path}`);
  }
  return report.source.status === 'read' ? 0 : 1;
}
