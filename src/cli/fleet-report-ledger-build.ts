/**
 * `ashlr fleet report-ledger-build` — write the due 07:30/20:00 ET
 * recorded-activity report files from the jobs ledger. No model, no
 * network, no gh (RQ-REPORTS-NO-GROK-1 report-file slice, recovered from
 * PR #4284).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildReportLedgerFiles,
  REPORT_SLOTS,
  type ReportSlot,
} from '../core/fleet/report-ledger-files.js';

const usage = `Usage: ashlr fleet report-ledger-build [--slot auto|0730|2000] [--force] [--runs-dir DIR] [--json]

Builds <runs-dir>/export/report-0730.md and report-2000.md — the 07:30 and
20:00 ET recorded-activity reports — from metrics/jobs.jsonl alone:
deterministic, no LLM, no network (runs-dir default: ASHLR_RUNS_DIR or
~/.ashlr-runs).

--slot auto (default) writes every slot whose ET build time (07:25 / 19:55
America/New_York) has passed today and whose file does not already carry
today's marker. A named slot builds on demand; a valid same-slot same-day
file skips unless --force. The marker must match both slot and ET day: a
report written for another slot never suppresses a build.

--json prints { schema, day, entries } with per-slot outcome/reason/bytes;
report bodies and absolute paths are never printed. Coverage is ledger
only: the world model, leader intents and Actions runs are not collected.`;

export interface FleetReportLedgerBuildDeps {
  runsDir?: string;
  now?: () => Date;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

interface ParsedArgs {
  slot: ReportSlot | 'auto';
  force: boolean;
  runsDir?: string;
  json: boolean;
}

/** Validate every flag before any filesystem write; unknown, duplicated or invalid flags reject. */
function parseArgs(args: string[]): ParsedArgs | null {
  let slot: ReportSlot | 'auto' = 'auto';
  let force = false;
  let json = false;
  let runsDir: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return null;
    seen.add(arg);
    const value = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--force') force = true;
    else if (arg === '--runs-dir' && value && !value.startsWith('--')) { runsDir = value; i++; }
    else if (arg === '--slot' && value && !value.startsWith('--')) {
      if (value !== 'auto' && !(REPORT_SLOTS as readonly string[]).includes(value)) return null;
      slot = value as ReportSlot | 'auto';
      i++;
    }
    else return null;
  }
  return { slot, force, runsDir, json };
}

export async function cmdFleetReportLedgerBuild(args: string[], deps: FleetReportLedgerBuildDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  const parsed = parseArgs(args);
  if (parsed === null) { error(usage); return 2; }
  const runsDir = parsed.runsDir ?? deps.runsDir
    ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const result = await buildReportLedgerFiles({
    runsDir, slot: parsed.slot, force: parsed.force, now: deps.now?.(),
  });
  if (parsed.json) {
    // Structured output stays free of private paths and raw error text: the
    // scrubbed failure detail prints in human output only.
    output(JSON.stringify({
      schema: result.schema,
      day: result.day,
      entries: result.entries.map(({ slot, outcome, reason, bytes }) => ({
        slot,
        outcome,
        reason: outcome === 'failed' ? 'failed' : reason,
        bytes,
      })),
    }));
    return 0;
  }
  if (result.entries.length === 0) {
    output(`no report slot due yet today (${result.day}); nothing written`);
    return 0;
  }
  for (const entry of result.entries) {
    output(entry.outcome === 'wrote'
      ? `wrote ${entry.path} (${entry.bytes} bytes)`
      : entry.outcome === 'skipped'
        ? `skipped ${entry.slot}: ${entry.reason}`
        : `failed ${entry.slot}: ${entry.reason}`);
  }
  return 0;
}
