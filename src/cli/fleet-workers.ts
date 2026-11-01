import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';

const usage = 'Usage: phm fleet workers [--lane ID] [--repo NAME] [--older-than-seconds N] [--expect-min N] [--json]';

/** Read the canonical host process projection once; filters apply only to worker rows. */
export async function cmdFleetWorkers(args: string[]): Promise<number> {
  const seen = new Set<string>();
  let lane: string | undefined;
  let repo: string | undefined;
  let olderThanSeconds: number | undefined;
  let expectMin: number | undefined;
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
    else if (flag === '--older-than-seconds' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      olderThanSeconds = Number(value);
      i++;
    }
    else if (flag === '--expect-min' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      expectMin = Number(value);
      i++;
    }
    else if (!['--json', '--help'].includes(flag)) {
      process.stderr.write(`error: invalid fleet workers arguments\n${usage}\n`);
      return 2;
    }
  }
  if (expectMin !== undefined && !seen.has('--json')) {
    process.stderr.write(`error: --expect-min requires --json\n${usage}\n`);
    return 2;
  }
  if (seen.has('--help')) {
    console.log(`${usage}\nFilters apply to worker rows; leaders and orchestrator agents remain global.\n` +
      '--older-than-seconds accepts a nonnegative safe integer; only ages strictly greater than N match. ' +
      'Unknown ages do not match and are counted after lane/repo filtering (null when the source is unavailable).\n' +
      '--expect-min accepts a nonnegative safe integer and requires --json; it checks the filtered live worker count.');
    return 0;
  }

  let snapshot: LiveWorkersSnapshot;
  try {
    snapshot = await listLiveWorkers();
  } catch {
    process.stderr.write('error: fleet workers unavailable\n');
    return 1;
  }
  const filtered = lane !== undefined || repo !== undefined || olderThanSeconds !== undefined;
  const candidates = snapshot.workers.filter(worker =>
    (lane === undefined || worker.lane === lane) && (repo === undefined || worker.repo === repo));
  const unknownAgeCount = snapshot.sourceState === 'healthy'
    ? candidates.filter(worker => worker.ageSeconds === null).length : null;
  const workers = olderThanSeconds === undefined ? candidates : candidates.filter(worker =>
    worker.ageSeconds !== null && worker.ageSeconds > olderThanSeconds);
  const result = filtered ? { ...snapshot, workers, workerFilter: { lane: lane ?? null, repo: repo ?? null,
    ...(olderThanSeconds === undefined ? {} : { olderThanSeconds, unknownAgeCount }),
    global: ['sourceState', 'leaders', 'orchestratorAgents'] } } : snapshot;
  const check = expectMin === undefined ? undefined : {
    v: 1, expected: expectMin, observed: snapshot.sourceState === 'healthy' ? workers.length : null,
    passed: snapshot.sourceState === 'healthy' && workers.length >= expectMin, sourceState: snapshot.sourceState,
  };
  if (seen.has('--json')) console.log(JSON.stringify(check === undefined ? result : { ...result, expectMinCheck: check }));
  else {
    const lines = [
      `Fleet workers: ${snapshot.sourceState}`,
      ...(filtered ? [`Worker rows filtered: lane=${lane ?? 'any'} repo=${repo ?? 'any'}` +
        (olderThanSeconds === undefined ? '' : ` older-than-seconds=${olderThanSeconds} unknown-ages=${unknownAgeCount ?? 'unavailable'}`) +
        '; leader and orchestrator totals are global'] : []),
      ...(snapshot.sourceState === 'healthy'
        ? [workers.length === 0 ? (filtered ? 'No matching live workers.' : 'No live workers.') : 'JOB  LANE  REPO  TIER  AGE',
          ...workers.map(worker => `${worker.job}  ${worker.lane}  ${worker.repo}  ${worker.tier}  ${worker.ageSeconds === null ? 'unknown' : `${worker.ageSeconds}s`}`),
          `Leaders (global): ${snapshot.leaders.length}; orchestrator agents (global): ${snapshot.orchestratorAgents}`]
        : ['Live process listing unavailable.']),
    ];
    console.log(lines.join('\n'));
  }
  return snapshot.sourceState === 'healthy' && (check === undefined || check.passed) ? 0 : 1;
}
