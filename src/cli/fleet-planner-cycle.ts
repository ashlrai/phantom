import { isAbsolute } from 'node:path';
import { resolveDropJobRoot } from '../core/fleet/drop-job-writer.js';
import {
  defaultPlannerCycleDeps, runPlannerCycle,
  type PlannerCycleDeps, type PlannerCycleReport,
} from '../core/fleet/planner-cycle.js';
import { validCycleRoute, publishCycleResult, type CycleRoute } from '../core/fleet/planner-cycle-bus-result.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

type IO = {
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
  home?: string;
  now?: () => number;
  deps?: Partial<PlannerCycleDeps>;
};

const USAGE = `Usage: ashlr fleet planner-cycle --prompt-file <absolute> [--runs-root <absolute>] [--run-id <token> --from <address> --to <address> [--root <absolute>]] [--apply] [--json]
Preview (default) selects the runner through executePlannerPass without
spawning. --apply runs exactly one pass — never retried, lanes unchanged —
then reads drop folders and the ingest ledger over the run's real
startedAt..finishedAt bounds. Verdicts: productive (exit 0), unproductive
(1 — zero exit with nothing produced, or rejected-only), failed (1),
skipped/ORCH_OFF (3), unknown (4 — missing or invalid evidence, never
success). Window evidence is observational and may include concurrent
planners' output; it is never claimed as exact attribution. With routing, preview
validates only; apply posts one bounded result to the durable bus. Routing labels
authenticate nobody. Rerunning may execute another pass: publication dedupe is
not execution idempotency.`;

function human(report: PlannerCycleReport): string {
  const { execution, evidence } = report;
  const lines = [
    `verdict: ${report.verdict}`,
    `execution: ${execution.outcome} provider=${execution.provider ?? 'none'} exit=${execution.exitCode ?? 'none'} reason=${execution.reason}`,
    `evidence: ${evidence.state} — ${evidence.detail}`,
  ];
  if (evidence.counts) {
    lines.push(`produced: ingested=${evidence.counts.ingested} pending=${evidence.counts.pending} rejected=${evidence.counts.rejected}`
      + ` [${[...evidence.ingested, ...evidence.pending].join(', ') || 'none'}]`);
    if (evidence.rejected.length > 0) lines.push(`rejected: ${evidence.rejected.map((row) => `${row.id} (${row.reason})`).join(', ')}`);
    if (evidence.sources) lines.push(`sources: ledger=${evidence.sources.ledger} drops=${evidence.sources.drops.join(',')} skipped=${evidence.sources.skipped}`);
  }
  if (evidence.window) lines.push(`window: ${evidence.window.since}..${evidence.window.until}`);
  if (evidence.note) lines.push(`note: ${evidence.note}`);
  return `${lines.join('\n')}\n`;
}

/** Convention loader entry: `fleet planner-cycle`. Deps, home and clock are programmatic seams only. */
export async function cmdFleetPlannerCycle(args: string[], io: IO = {}, bus: BusInboxOptions = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${USAGE}\n`); return 2; };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { output.write(`${USAGE}\n`); return 0; }

  let prompt: string | undefined, root: string | undefined, apply = false, json = false;
  const routing = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--apply' && !apply) { apply = true; continue; }
    if ((flag === '--prompt-file' && prompt === undefined) || (flag === '--runs-root' && root === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0')) return invalid();
      if (flag === '--prompt-file') prompt = value; else root = value;
      continue;
    }
    if (flag && ['--run-id', '--from', '--to', '--root'].includes(flag) && !routing.has(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0')) return invalid();
      routing.set(flag, value);
      continue;
    }
    return invalid();
  }
  if (!prompt || !isAbsolute(prompt) || (root !== undefined && !isAbsolute(root))) return invalid();
  let runsRoot: string;
  try { runsRoot = resolveDropJobRoot(root); } catch { return invalid(); }

  const runId = routing.get('--run-id'), from = routing.get('--from'), to = routing.get('--to');
  const busRoot = routing.get('--root');
  const route: CycleRoute | undefined = runId && from && to ? { runId, from, to } : undefined;
  if ((routing.size > 0 && !route) || (busRoot !== undefined && !isAbsolute(busRoot)) ||
      (route && !validCycleRoute(route))) return invalid();
  if (route && !apply) {
    output.write(json ? `${JSON.stringify({ report: null, delivery: { status: 'preview' } })}\n` : 'delivery: preview (no pass or post)\n');
    return 0;
  }

  const deps: PlannerCycleDeps = { ...defaultPlannerCycleDeps, ...(io.deps ?? {}) };
  const { report, exitCode } = await runPlannerCycle(
    { runsRoot, promptPath: prompt, apply, home: io.home, now: io.now }, deps);
  const safe = sanitizePublicJson(report) as PlannerCycleReport;
  if (!route) {
    output.write(json ? `${JSON.stringify(safe)}\n` : human(safe));
    return exitCode;
  }
  const delivery = publishCycleResult(route, report, busRoot === undefined ? bus : { ...bus, root: busRoot });
  output.write(json ? `${JSON.stringify({ report: safe, delivery })}\n` : `${human(safe)}delivery: ${delivery.status}\n`);
  return exitCode || (delivery.status === 'posted' || delivery.status === 'duplicate' ? 0 : 1);
}
