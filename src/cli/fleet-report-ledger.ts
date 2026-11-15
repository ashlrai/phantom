/**
 * `ashlr fleet report-ledger` — deterministic 12-hour recorded-activity
 * report from the jobs ledger. No model, no network, no gh: the ledger file
 * is the source of truth when every relay is down (RQ-REPORTS-NO-GROK-1
 * ledger slice, recovered from PR #4284).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildReportLedger, renderReportLedgerText, type ReportLedger } from '../core/fleet/report-ledger.js';

const usage = `Usage: ashlr fleet report-ledger [--runs-dir DIR] [--json]

Prints a bounded summary of recorded fleet activity over the trailing 12
hours, read from <runs-dir>/metrics/jobs.jsonl (default: ASHLR_RUNS_DIR or
~/.ashlr-runs). Deterministic: no LLM, no network. A missing ledger reports
"unavailable" with unknown counts; a truncated tail reports "incomplete".

--json prints one ashlar.fleet-report-ledger/v1 object: window, ledger
coverage, counts (null when unavailable), per-lane breakdown and up to 12
published + 12 merged PR evidence rows. Observation only — it never
authorizes dispatch or merges.`;

export interface FleetReportLedgerDeps {
  runsDir?: string;
  now?: () => Date;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/** Validate flags before any read; unknown or duplicated flags exit 2. */
function parseArgs(args: string[]): { runsDir?: string; json: boolean } | null {
  let runsDir: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return null;
    if (seen.has(arg)) return null;
    seen.add(arg);
    const value = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && value && !value.startsWith('--')) { runsDir = value; i++; }
    else return null;
  }
  return { runsDir, json };
}

export async function cmdFleetReportLedger(args: string[], deps: FleetReportLedgerDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  const parsed = parseArgs(args);
  if (parsed === null) { error(usage); return 2; }
  const runsDir = parsed.runsDir ?? deps.runsDir
    ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const report: ReportLedger = await buildReportLedger({ runsDir, now: deps.now?.() });
  output(parsed.json ? JSON.stringify(report) : renderReportLedgerText(report));
  return 0;
}
