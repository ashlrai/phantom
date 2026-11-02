import { isAbsolute } from 'node:path';
import { resolveDropJobRoot } from '../core/fleet/drop-job-writer.js';
import { readPlannerPassOutput, summarizePlannerPassOutput } from '../core/fleet/planner-pass-output.js';

type IO = { stdout?: { write(text: string): unknown }; now?: () => number; home?: string };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;

export async function cmdFleetPlannerOutput(args: string[], io: IO = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  let since: string | undefined, until: string | undefined, root: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if ((flag === '--since' && since === undefined) || (flag === '--until' && until === undefined) || (flag === '--runs-dir' && root === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0')) return 2;
      if (flag === '--since') since = value;
      else if (flag === '--until') until = value;
      else root = value;
      continue;
    }
    return 2;
  }
  if (!since || !ISO.test(since) || !Number.isFinite(Date.parse(since)) ||
      (until !== undefined && (!ISO.test(until) || !Number.isFinite(Date.parse(until)))) ||
      (root !== undefined && !isAbsolute(root))) return 2;
  const sinceMs = Date.parse(since);
  const untilMs = until === undefined ? undefined : Date.parse(until);
  if (untilMs !== undefined && untilMs < sinceMs) return 2;
  let runsRoot: string;
  try { runsRoot = resolveDropJobRoot(root); } catch { return 2; }
  const view = await readPlannerPassOutput({ runsRoot, home: io.home, sinceMs, untilMs, now: io.now });
  if (json) output.write(`${JSON.stringify(view)}\n`);
  else {
    output.write(`${summarizePlannerPassOutput(view)}\n`);
    output.write(`Ingested: ${view.ingested.map((item) => item.id).join(', ') || 'none'}\n`);
    output.write(`Pending: ${view.pending.map((item) => item.id).join(', ') || 'none'}\n`);
    output.write(`Rejected: ${view.rejected.map((item) => item.id).join(', ') || 'none'}\n`);
    output.write(`Sources: ledger=${view.sources.ledger}, drops=${view.sources.drops.map((source) => source.state).join(',')}, skipped=${view.sources.skipped}\n`);
  }
  return 0;
}
