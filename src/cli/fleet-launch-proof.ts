import { readFleetRunsDirState, type FleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';
import { launchProofCheck } from '../core/fleet/launch-proof-check.js';

interface Readers {
  runs: () => Promise<FleetRunsDirState>;
  workers: () => Promise<LiveWorkersSnapshot>;
  now: () => number;
}
const readers: Readers = { runs: readFleetRunsDirState, workers: listLiveWorkers, now: Date.now };

/** Read one status snapshot and one live process table; never dispatch work. */
export async function cmdFleetLaunchProof(args: string[], deps: Readers = readers): Promise<number> {
  const usage = 'Usage: ashlr fleet launch-proof [--json] [--lane <lane>] [--help]';
  const seen = new Set<string>();
  let lane: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] === '-h' ? '--help' : args[i]!;
    if (flag === '--lane' && !seen.has(flag) && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(args[i + 1] ?? '')) {
      lane = args[++i];
    } else if (!['--json', '--help'].includes(flag) || seen.has(flag)) {
      process.stderr.write(`error: invalid fleet launch-proof arguments\n${usage}\n`);
      return 2;
    }
    seen.add(flag);
  }
  if (seen.has('--help')) {
    console.log(`${usage}\nCompares one runs snapshot with one process-table observation, using a five-minute freshness limit. Exit 0 requires fresh healthy evidence and no lane discrepancies; exit 1 indicates failed or unavailable evidence. Launch wrappers do not prove provider token consumption.`);
    return 0;
  }
  const [status, workers] = await Promise.allSettled([
    Promise.resolve().then(() => deps.runs()),
    Promise.resolve().then(() => deps.workers()),
  ]);
  const result = launchProofCheck(status.status === 'fulfilled' ? status.value : null,
    workers.status === 'fulfilled' ? workers.value : null, deps.now(), lane);
  if (seen.has('--json')) console.log(JSON.stringify(result));
  else console.log([
    `Fleet launch proof: ${result.unavailable ? 'unavailable' : result.ok ? 'healthy' : 'failure'}`,
    ...result.reasons,
    ...result.lanes.map(row => `${row.lane}: reported=${row.reportedRunning} observed=${row.observedWorkerJobs ?? 'unknown'}; ${row.assessment}${row.discrepancies.length ? ` (${row.discrepancies.join(', ')})` : ''}`),
    result.limitation,
  ].join('\n'));
  return result.ok ? 0 : 1;
}
