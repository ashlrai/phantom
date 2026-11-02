import { isAbsolute } from 'node:path';
import { isFleetJobId } from '../core/fleet/runs-job-detail.js';
import { getFleetJobCost, type FleetJobCostV1 } from '../core/fleet/runs-job-cost.js';

const usage = 'Usage: phm job cost <id> [--json] [--runs-dir <abs>] [--help]';
const text = (v: number | string | null): string => v === null ? 'unknown' : String(v);
const money = (v: number | null): string => v === null ? 'unknown' : `$${v.toFixed(4)}`;

function formatCost(job: FleetJobCostV1): string {
  const { totals } = job;
  const priced = `${totals.reported.costUsd}/${totals.calls}`;
  const lines = [
    `Job ${job.job}: ${totals.calls} ${totals.calls === 1 ? 'call' : 'calls'}, ` +
      `${text(totals.inputTokens)} in / ${text(totals.outputTokens)} out, cost ${money(totals.costUsd)}` +
      (totals.calls > 0 && totals.reported.costUsd < totals.calls ? ` (priced ${priced})` : '') +
      (totals.errors > 0 ? `, ${totals.errors} errored` : ''),
  ];
  for (const call of job.calls) {
    lines.push(
      `  ${call.at ?? 'unknown'}  ${call.model ?? 'unknown'}  ` +
      `${text(call.inputTokens)}→${text(call.outputTokens)}  ${money(call.costUsd)}` +
      `${call.estimated ? ' (estimated)' : ''}${call.error ? ' [error]' : ''}`,
    );
  }
  if (job.jobTotals.finishes > 0) {
    lines.push(`Worker-reported tokens_total over ${job.jobTotals.finishes} finish ${job.jobTotals.finishes === 1 ? 'event' : 'events'}: ${text(job.jobTotals.tokensTotal)}`);
  }
  if (job.sources.apiSpend === 'missing' && job.sources.jobs === 'missing') {
    lines.push('No cost evidence recorded for this job.');
  } else if (job.calls.length === 0) {
    lines.push('No recorded model calls for this job.');
  }
  if (job.truncated) lines.push('Earlier rows may exist beyond the read window.');
  return lines.join('\n');
}

/**
 * `phm job cost <id>` — per-model-call cost breakdown for one fleet job
 * (fleet.job.cost.v1). Reads the host's metrics ledgers; never fabricates:
 * a field with no evidence is null in --json and 'unknown' in text.
 * Exit codes: 0 ok, 1 read failure, 2 bad usage.
 */
export async function cmdJob(args: string[]): Promise<number> {
  const invalid = (extra?: string): number => {
    console.error(extra ? `${extra}\n${usage}` : usage);
    return 2;
  };
  const [verb, ...rest] = args;
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(`${usage}\nPer-model-call cost for a fleet job: tokens in/out, model and cost (or 'unknown'), from the runs metrics ledgers. --json emits fleet.job.cost.v1.`);
    return 0;
  }
  if (verb !== 'cost') return invalid(`unknown job command: ${verb}`);
  let id: string | undefined;
  let json = false;
  let runsDir: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') {
      if (seen.has('--json')) return invalid();
      seen.add('--json'); json = true;
    } else if (arg === '--runs-dir') {
      if (seen.has('--runs-dir')) return invalid();
      seen.add('--runs-dir');
      const dir = rest[++i];
      if (!dir || dir.startsWith('--') || !isAbsolute(dir)) return invalid();
      runsDir = dir;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`${usage}\nPer-model-call cost for a fleet job: tokens in/out, model and cost (or 'unknown'), from the runs metrics ledgers. --json emits fleet.job.cost.v1.`);
      return 0;
    } else if (!id && !arg.startsWith('-') && isFleetJobId(arg)) {
      id = arg;
    } else {
      return invalid();
    }
  }
  if (!id) return invalid();
  try {
    const job = await getFleetJobCost(id, runsDir === undefined ? {} : { runsDir });
    console.log(json ? JSON.stringify(job) : formatCost(job));
    return 0;
  } catch {
    console.error('error: job cost unavailable');
    return 1;
  }
}
