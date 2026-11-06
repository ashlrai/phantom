#!/usr/bin/env -S npx tsx
/* global process */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';
import { listLiveWorkers } from '../../src/core/fleet/runs-live-workers.js';
import { readResourceLedger } from '../../src/core/fleet/runs-resource-ledger.js';

const HELP = `Usage: npx tsx examples/upgrade/host-preflight.ts [--help]

Read local host evidence and print a bounded host-preflight.v1 JSON report.
Exit codes: 0 verified, 1 mismatch or failure, 2 usage, 3 insufficient evidence.
`;
const MAX_AGE_SECONDS = 300;
type Dependencies = {
  runs?: typeof readFleetRunsDirState;
  workers?: typeof listLiveWorkers;
  ledger?: typeof readResourceLedger;
  now?: () => number;
  write?: (text: string) => void;
};

/** Age is unknown for missing, invalid, or future evidence. */
function age(at: string | null | undefined, now: number): number | null {
  const time = at ? Date.parse(at) : NaN;
  return Number.isFinite(time) && time <= now ? Math.floor((now - time) / 1000) : null;
}

/** Read independent host projections; never forward source content or exception text. */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  if (args.length === 1 && args[0] === '--help') { write(HELP); return 0; }
  if (args.length) {
    write(`${JSON.stringify({ error: 'Invalid arguments. Use --help for usage.' })}\n`);
    return 2;
  }
  const now = (deps.now ?? Date.now)();
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    write(`${JSON.stringify({ error: 'Unable to read host preflight.' })}\n`);
    return 1;
  }
  // The ledger otherwise scans a personal session directory; this report needs
  // only runs-root sources. A filesystem root disables that optional collector.
  const [runsResult, workersResult, ledgerResult] = await Promise.allSettled([
    Promise.resolve().then(() => (deps.runs ?? readFleetRunsDirState)({ now: () => now })),
    Promise.resolve().then(() => (deps.workers ?? listLiveWorkers)({ now: () => now })),
    Promise.resolve().then(() => (deps.ledger ?? readResourceLedger)({ now: () => now, personalCodexHome: resolve('/') })),
  ]);
  const runs = runsResult.status === 'fulfilled' ? runsResult.value : null;
  const workers = workersResult.status === 'fulfilled' ? workersResult.value : null;
  const ledger = ledgerResult.status === 'fulfilled' ? ledgerResult.value : null;
  const dispatchAge = age(runs?.lastTick, now);
  const processAge = age(workers?.generatedAt, now);
  const ledgerAge = age(ledger?.asOf, now);
  const dispatchUsable = !!runs && runs.sources.status === 'healthy' && dispatchAge !== null && dispatchAge <= MAX_AGE_SECONDS;
  const processUsable = !!workers && workers.sourceState === 'healthy' && processAge !== null && processAge <= MAX_AGE_SECONDS;
  const usageUsable = !!ledger && ledger.sources.apiSpend === 'healthy' && ledger.sources.jobs === 'healthy';
  const running = dispatchUsable ? runs.lanes.reduce((sum, lane) => sum + lane.running, 0) : null;
  const workerCount = processUsable ? workers.workers.length : null;
  const leaderCount = processUsable ? workers.leaders.length : null;
  const agentCount = processUsable ? workers.orchestratorAgents : null;
  const mismatch = running !== null && workerCount !== null && running !== workerCount;
  const active = processUsable && (workerCount! > 0 || leaderCount! > 0 || agentCount! > 0);
  const failed = !runs || !workers || !ledger || runs.sourceState === 'degraded' && !runs.runsDirPresent ||
    runs.sources.status === 'degraded' || workers.sourceState === 'unavailable' ||
    ledger.sources.apiSpend === 'degraded' || ledger.sources.jobs === 'degraded';
  const blockers: string[] = [];
  if (!dispatchUsable) blockers.push('dispatch-unavailable');
  if (!processUsable) blockers.push('processes-unavailable');
  if (!usageUsable) blockers.push('usage-unavailable');
  if (mismatch) blockers.push('worker-count-mismatch');
  if (active) blockers.push('processes-active');
  if (!runs || !workers || !ledger) blockers.push('reader-failed');
  const code = failed || mismatch || active ? 1 : blockers.length ? 3 : 0;
  const report = {
    schema: 'host-preflight.v1', generatedAt: new Date(now).toISOString(),
    dispatch: { usable: dispatchUsable, rootPresent: runs?.runsDirPresent ?? null,
      rootHealth: runs?.sourceState ?? 'error', sources: runs?.sources ?? null,
      lastTickAgeSeconds: dispatchAge, paused: dispatchUsable ? runs.paused : null, running },
    processes: { usable: processUsable, source: workers?.sourceState ?? 'error',
      snapshotAgeSeconds: processAge, workers: workerCount, leaders: leaderCount,
      orchestratorAgents: agentCount, state: !processUsable ? 'unknown' : active ? 'active' : 'idle' },
    usage: { usable: usageUsable, sources: ledger?.sources ?? null,
      statusAgeSeconds: ledgerAge, lastApiActivityAgeSeconds: age(ledger?.apiSpend?.lastAt, now) },
    blockers,
  };
  write(`${JSON.stringify(report)}\n`);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
