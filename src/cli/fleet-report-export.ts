import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildScheduledReports,
  REPORT_SLOTS,
  type ReportFactsDeps,
  type ReportSlot,
} from '../core/fleet/report-export.js';

const usage = `Usage: ashlr fleet report-export [--slot ${[...REPORT_SLOTS].join('|')}|auto] [--runs-dir DIR] [--force] [--json]

Builds ~/.ashlr-runs/export/report-0730.md and report-2000.md — the 7:30 AM and
8:00 PM ET fleet reports — from the world model, the recorded jobs ledger and
the leader's in-force intents, plus bounded gh run-list evidence. Deterministic:
no LLM, no Grok. The desktop Leader panel reads the files; relays only forward
them, so the reports stay the source of truth when relays are down.

--slot auto (default) writes every slot whose build time (07:25 / 19:55
America/New_York) has passed today and whose report does not already carry
today's marker. A named slot builds that slot now (still day-gated unless
--force). --json prints { schema, day, entries }; report bodies are never
printed.`;

export interface FleetReportExportDeps {
  runsDir?: string;
  now?: () => Date;
  facts?: ReportFactsDeps;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/**
 * `ashlr fleet report-export` — scheduled EO reports without a model.
 * Local file writes only: no network except the bounded `gh run list` read.
 */
export async function cmdFleetReportExport(args: string[], deps: FleetReportExportDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let slot: ReportSlot | 'auto' = 'auto';
  let force = false;
  let json = false;
  let runsDir = root;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output(usage); return 0; }
    if (seen.has(arg)) { error(usage); return 2; }
    seen.add(arg);
    const value = args[i + 1];
    if (arg === '--force') force = true;
    else if (arg === '--json') json = true;
    else if (arg === '--slot' && value && !value.startsWith('--')) {
      if (value !== 'auto' && !(REPORT_SLOTS as readonly string[]).includes(value)) { error(usage); return 2; }
      slot = value as ReportSlot | 'auto';
      i++;
    } else if (arg === '--runs-dir' && value && !value.startsWith('--')) {
      runsDir = value;
      i++;
    } else { error(usage); return 2; }
  }
  const result = await buildScheduledReports({
    runsDir, slot, force, now: deps.now?.(), deps: deps.facts,
  });
  if (json) {
    output(JSON.stringify(result));
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
