import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';

const usage = 'Usage: phm fleet workers [--lane ID] [--repo NAME] [--json]';

/** Read the canonical host process projection once; filters apply only to worker rows. */
export async function cmdFleetWorkers(args: string[]): Promise<number> {
  const seen = new Set<string>();
  let lane: string | undefined;
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] === '-h' ? '--help' : args[i]!;
    if (seen.has(flag)) {
      process.stderr.write(`error: invalid fleet workers arguments\n${usage}\n`);
      return 2;
    }
    seen.add(flag);
    const value = args[i + 1] ?? '';
    if (flag === '--lane' && !value.startsWith('--') && /^[a-z0-9-]{1,32}$/.test(value)) lane = args[++i];
    else if (flag === '--repo' && !value.startsWith('--') && /^[a-z0-9._-]{1,64}$/.test(value)) repo = args[++i];
    else if (!['--json', '--help'].includes(flag)) {
      process.stderr.write(`error: invalid fleet workers arguments\n${usage}\n`);
      return 2;
    }
  }
  if (seen.has('--help')) {
    console.log(`${usage}\nFilters apply to worker rows; leaders and orchestrator agents remain global.`);
    return 0;
  }

  let snapshot: LiveWorkersSnapshot;
  try {
    snapshot = await listLiveWorkers();
  } catch {
    process.stderr.write('error: fleet workers unavailable\n');
    return 1;
  }
  const filtered = lane !== undefined || repo !== undefined;
  const workers = snapshot.workers.filter(worker =>
    (lane === undefined || worker.lane === lane) && (repo === undefined || worker.repo === repo));
  const result = filtered ? { ...snapshot, workers, workerFilter: { lane: lane ?? null, repo: repo ?? null,
    global: ['sourceState', 'leaders', 'orchestratorAgents'] } } : snapshot;
  if (seen.has('--json')) console.log(JSON.stringify(result));
  else {
    const lines = [
      `Fleet workers: ${snapshot.sourceState}`,
      ...(filtered ? [`Worker rows filtered: lane=${lane ?? 'any'} repo=${repo ?? 'any'}; leader and orchestrator totals are global`] : []),
      ...(snapshot.sourceState === 'healthy'
        ? [workers.length === 0 ? (filtered ? 'No matching live workers.' : 'No live workers.') : 'JOB  LANE  REPO  TIER  AGE',
          ...workers.map(worker => `${worker.job}  ${worker.lane}  ${worker.repo}  ${worker.tier}  ${worker.ageSeconds === null ? 'unknown' : `${worker.ageSeconds}s`}`),
          `Leaders (global): ${snapshot.leaders.length}; orchestrator agents (global): ${snapshot.orchestratorAgents}`]
        : ['Live process listing unavailable.']),
    ];
    console.log(lines.join('\n'));
  }
  return snapshot.sourceState === 'healthy' ? 0 : 1;
}
