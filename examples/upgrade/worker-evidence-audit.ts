#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../../src/core/fleet/runs-job-detail.js';
import { listLiveWorkers, type LiveWorker, type LiveWorkersSnapshot } from '../../src/core/fleet/runs-live-workers.js';
import { scrubSecrets } from '../../src/core/util/scrub.js';

const LIMIT = 100;
const HELP = `Usage: npx tsx examples/upgrade/worker-evidence-audit.ts [--help]

Compare live worker wrappers with the installed host's fleet job detail evidence.
Exit codes: 0 verified, 1 mismatch or reader failure, 2 usage, 3 insufficient evidence.
`;

type Dependencies = {
  live?: () => Promise<LiveWorkersSnapshot>;
  detail?: (job: string) => Promise<FleetJobDetailV1>;
  write?: (text: string) => void;
};
type Comparison = 'match' | 'mismatch' | 'unknown';

// Do not emit arbitrary detail fields: even a model name may be path-like or secret-like.
function safeToken(value: string | null): string | null {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,79}$/.test(value) && scrubSecrets(value) === value ? value : null;
}
function timestamp(value: string): string | null {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;
}
function compare(left: string | null, right: string | null): Comparison {
  return left === null || right === null ? 'unknown' : left === right ? 'match' : 'mismatch';
}
function project(worker: LiveWorker, detail: FleetJobDetailV1) {
  const liveLane = safeToken(worker.lane), liveTier = safeToken(worker.tier);
  const lane = safeToken(detail.lane), tier = safeToken(detail.tier), model = safeToken(detail.model);
  const state = ['running', 'published', 'archived', 'unknown'].includes(detail.state) ? detail.state : 'unknown';
  const sources = Object.fromEntries((['launch', 'base', 'meta', 'publish', 'log'] as const).map(key => {
    const value = detail.sources[key];
    return [key, value === 'healthy' || value === 'missing' || value === 'degraded' ? value : 'unknown'];
  }));
  const comparisons = {
    lane: compare(liveLane, lane), tier: compare(liveTier, tier),
    state: compare('running', state === 'unknown' ? null : state),
    // The live reader does not expose a model, so it cannot corroborate one.
    model: 'unknown' as const,
  };
  const mismatch = Object.values(comparisons).includes('mismatch');
  const insufficient = comparisons.lane === 'unknown' || comparisons.tier === 'unknown'
    || comparisons.state === 'unknown' || model === null
    || sources.launch !== 'healthy' || sources.meta !== 'healthy' || sources.log !== 'healthy'
    || Object.values(sources).some(source => source === 'degraded' || source === 'unknown');
  return {
    row: { job: worker.job, pid: worker.pid, live: { lane: liveLane, tier: liveTier, state: 'running' },
      detail: { observedAt: timestamp(detail.generatedAt), lane, tier, model, state, sources }, comparisons },
    mismatch, insufficient,
  };
}

/** One live snapshot followed by up to 100 distinct detail reads, at most two at a time. */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => { process.stdout.write(text); });
  if (args.length === 1 && args[0] === '--help') { write(HELP); return 0; }
  if (args.length !== 0) { write('{"error":"Invalid arguments. Use --help."}\n'); return 2; }
  let live: LiveWorkersSnapshot;
  try { live = await (deps.live ?? listLiveWorkers)(); }
  catch { write('{"error":"Unable to read live workers."}\n'); return 1; }
  if (live.sourceState !== 'healthy') { write('{"error":"Live worker source unavailable."}\n'); return 1; }

  const distinct = [...new Map(live.workers.map(worker => [worker.job, worker])).values()];
  const selected = distinct.slice(0, LIMIT);
  const rows: Array<ReturnType<typeof project> | null> = Array(selected.length).fill(null);
  let next = 0;
  async function readNext(): Promise<void> {
    while (next < selected.length) {
      const index = next++;
      const worker = selected[index]!;
      try {
        if (!isFleetJobId(worker.job)) throw new Error('invalid id');
        const detail = await (deps.detail ?? getFleetJobDetail)(worker.job);
        rows[index] = project(worker, detail);
      } catch { /* Preserve every other result; never expose reader errors. */ }
    }
  }
  await Promise.all([readNext(), readNext()]);
  const omittedJobs = distinct.length - selected.length;
  const failed = rows.some(row => row === null);
  const mismatch = rows.some(row => row?.mismatch);
  const insufficient = omittedJobs > 0 || selected.length === 0 || rows.some(row => row?.insufficient);
  write(`${JSON.stringify({ schema: 'worker-evidence-audit.v1', liveObservedAt: timestamp(live.generatedAt),
    liveSource: live.sourceState, omittedJobs, workers: rows.map((row, index) => row?.row ?? {
      job: isFleetJobId(selected[index]!.job) ? selected[index]!.job : null,
      pid: selected[index]!.pid, error: 'Detail unavailable.',
    }) })}\n`);
  return failed || mismatch ? 1 : insufficient ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
