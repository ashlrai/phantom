import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';

const usage = 'Usage: phm fleet workers [--lane ID] [--repo NAME] [--older-than-seconds N] [--watch [--interval-ms N] [--max-samples N]] [--json]';
const MAX_CONSECUTIVE_ERRORS = 3;

/** Wait for an operation or a signal, removing the abort listener in either case. */
async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let onAbort: () => void = () => {};
  const aborted = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Read the canonical host process projection; filters apply only to worker rows. */
export async function cmdFleetWorkers(args: string[]): Promise<number> {
  const seen = new Set<string>();
  let lane: string | undefined;
  let repo: string | undefined;
  let olderThanSeconds: number | undefined;
  let intervalMs = 1000;
  let maxSamples: number | undefined;
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
    else if ((flag === '--interval-ms' || flag === '--max-samples') && /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)) && Number(value) >= (flag === '--interval-ms' ? 1000 : 1) &&
      Number(value) <= (flag === '--interval-ms' ? 60000 : 10000)) {
      if (flag === '--interval-ms') intervalMs = Number(value);
      else maxSamples = Number(value);
      i++;
    }
    else if (!['--json', '--help', '--watch'].includes(flag)) {
      process.stderr.write(`error: invalid fleet workers arguments\n${usage}\n`);
      return 2;
    }
  }
  if (!seen.has('--watch') && (seen.has('--interval-ms') || seen.has('--max-samples'))) {
    process.stderr.write(`error: invalid fleet workers arguments\n${usage}\n`);
    return 2;
  }
  if (seen.has('--help')) {
    console.log(`${usage}\nFilters apply to worker rows; leaders and orchestrator agents remain global.\n` +
      '--older-than-seconds accepts a nonnegative safe integer; only ages strictly greater than N match. ' +
      'Unknown ages do not match and are counted after lane/repo filtering (null when the source is unavailable).\n' +
      'Watch samples immediately, then every --interval-ms (1000..60000, default 1000); ' +
      '--max-samples (1..10000) counts healthy observations. Watch stops after 3 consecutive errors.\n' +
      'Watch JSON emits snapshots or {\"v\":1,\"error\":\"fleet workers unavailable\",\"sourceState\":\"unavailable\"} per line.');
    return 0;
  }

  const render = (snapshot: LiveWorkersSnapshot): number => {
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
    if (seen.has('--json')) console.log(JSON.stringify(result));
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
    return snapshot.sourceState === 'healthy' ? 0 : 1;
  };

  if (!seen.has('--watch')) {
    let snapshot: LiveWorkersSnapshot;
    try {
      snapshot = await listLiveWorkers();
    } catch {
      process.stderr.write('error: fleet workers unavailable\n');
      return 1;
    }
    return render(snapshot);
  }

  const controller = new AbortController();
  let exitCode = 0;
  const onSigint = () => { exitCode = 130; controller.abort(); };
  const onSigterm = () => { exitCode = 143; controller.abort(); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    let samples = 0;
    let consecutiveErrors = 0;
    while (!controller.signal.aborted) {
      // Catch synchronous and asynchronous failures without exposing their contents.
      const read = Promise.resolve().then(() => listLiveWorkers()).catch(() => null);
      const snapshot = await untilAborted(read, controller.signal);
      if (controller.signal.aborted) break;
      if (!snapshot || snapshot.sourceState !== 'healthy') {
        if (seen.has('--json')) console.log(JSON.stringify({ v: 1, error: 'fleet workers unavailable', sourceState: 'unavailable' }));
        else process.stderr.write('error: fleet workers unavailable\n');
        if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return 1;
      } else {
        consecutiveErrors = 0;
        render(snapshot);
        if (++samples === maxSamples) return 0;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await untilAborted(new Promise<void>(resolve => { timer = setTimeout(resolve, intervalMs); }), controller.signal);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return exitCode;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
