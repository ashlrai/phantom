/**
 * `ashlr fleet cos-work` — one bounded chief-of-staff worker pass
 * (RQ-PHX-COSWORKONCE11). Dry-run by default; with --apply, claims the oldest READY cos-* intake job, runs one
 * headless model turn on the declared planner slate, and records the reply as
 * a draft that needs Mason's approval. Sends nothing. Callers that want a
 * loop invoke this verb once per tick; the pass itself is never recurring.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { QueueStore } from '../core/queue/store.js';
import { runCosWorkOnce, type CosWorkOptions, type CosWorkResult } from '../core/cos/worker.js';

const usage = `Usage: ashlr fleet cos-work [--apply] [--runs-dir <abs>] [--json]
Dry run by default: count pending jobs without claiming or spawning.
With --apply, one bounded chief-of-staff pass: claim the oldest READY cos-* intake job, run
one headless model turn on the declared planner slate, and record the reply
as a draft awaiting Mason's approval in NEEDS-MASON.md. Sends nothing.
Exit 0 for idle, paused or drafted; 1 for blocked; 2 for usage errors.`;

const line = (result: CosWorkResult): string =>
  result.outcome === 'drafted' ? `drafted ${result.id} via ${result.provider}`
    : result.outcome === 'blocked' ? `blocked ${result.id}: ${result.reason}`
      : result.outcome;

export type FleetCosWorkDeps = Pick<CosWorkOptions, 'now' | 'spawn' | 'candidates' | 'timeoutMs'> & {
  output?: (text: string) => void;
  error?: (text: string) => void;
};

export async function cmdFleetCosWork(args: string[], deps: FleetCosWorkDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  const json = args.includes('--json');
  let apply = false, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') continue;
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (value && isAbsolute(value)) { runsDir = value; continue; }
    }
    if (arg === '--help' || arg === '-h') { output(json ? JSON.stringify({ usage }) : usage); return 0; }
    error(`Invalid arguments. ${usage.split('\n')[0]}`);
    return 2;
  }
  runsDir ??= process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  try {
    if (!apply) {
      const jobs = (await new QueueStore(join(runsDir, 'queue')).read()).jobs
        .filter(job => job.status === 'READY' && job.id.startsWith('cos-'));
      const report = { v: 1, mode: 'dry-run', pending: jobs.length, next: jobs[0]?.id ?? null };
      output(json ? JSON.stringify(report) : `pending=${report.pending} next=${report.next ?? 'none'}`);
      return 0;
    }
    const result = await runCosWorkOnce({ runsDir, now: deps.now, spawn: deps.spawn,
      candidates: deps.candidates, timeoutMs: deps.timeoutMs });
    output(json ? JSON.stringify(result) : line(result));
    return result.outcome === 'blocked' ? 1 : 0;
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : 'cos-work failed';
    if (json) output(JSON.stringify({ error: message }));
    else error(message);
    return 1;
  }
}
