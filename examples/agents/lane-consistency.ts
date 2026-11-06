#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readFleetRunsDirState, type FleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../../src/core/fleet/runs-live-workers.js';
import { scrubSecrets } from '../../src/core/util/scrub.js';

const MAX_LANES = 100;
const MAX_WAIT_MS = 5_000;
const usage = 'Usage: npx tsx examples/agents/lane-consistency.ts [--runs-dir PATH] [--wait-ms 0-5000] [--help]';

type Dependencies = {
  runs: typeof readFleetRunsDirState;
  workers: typeof listLiveWorkers;
  now: () => number;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
};

/** Join only the already-scrubbed projections; worker details never enter the report. */
export function laneConsistency(runs: FleetRunsDirState, live: LiveWorkersSnapshot, generatedAt: string) {
  const validLane = (lane: string) => /^[a-z0-9-]{1,32}$/.test(lane) && scrubSecrets(lane) === lane;
  const dispatch = new Map(runs.lanes.filter(row => validLane(row.lane)).map(row => [row.lane, row.running]));
  const counts = new Map<string, number>();
  let invalidWorkers = false;
  for (const worker of live.workers) {
    if (!validLane(worker.lane)) { invalidWorkers = true; continue; }
    counts.set(worker.lane, (counts.get(worker.lane) ?? 0) + 1);
  }
  const names = [...new Set([...dispatch.keys(), ...counts.keys()])].sort();
  const liveAvailable = live.sourceState === 'healthy' && !invalidWorkers;
  return {
    v: 1, generatedAt,
    observation: {
      dispatch: { generatedAt: runs.generatedAt, lastTick: runs.lastTick && runs.lastTick.length <= 64 ? runs.lastTick : null, sourceState: runs.sourceState, status: runs.sources.status },
      workers: { generatedAt: live.generatedAt, sourceState: live.sourceState, invalidLane: invalidWorkers },
    },
    omittedLanes: Math.max(0, names.length - MAX_LANES),
    lanes: names.slice(0, MAX_LANES).map(lane => {
      const reported = runs.sources.status === 'healthy' ? dispatch.get(lane) ?? null : null;
      const workers = liveAvailable ? counts.get(lane) ?? 0 : null;
      return { lane, reported, workers, delta: reported === null || workers === null ? null : reported - workers,
        consistency: reported === null || workers === null ? 'unknown' : reported === workers ? 'matched' : 'mismatched' };
    }),
  };
}

/** Read one snapshot after an optional bounded delay; no source contents are executed. */
export async function runLaneConsistency(args: string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const deps: Dependencies = {
    runs: readFleetRunsDirState, workers: listLiveWorkers, now: Date.now,
    wait: async (ms, signal) => { await delay(ms, undefined, { signal }); },
    stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); }, ...overrides,
  };
  let runsDir: string | undefined;
  let waitMs: number | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = args[i + 1];
    if (arg === '--runs-dir' && runsDir === undefined && value && !value.startsWith('-') && value.length <= 4096) {
      runsDir = value; i++;
    } else if (arg === '--wait-ms' && waitMs === undefined && value && /^(0|[1-9]\d{0,3})$/.test(value) && Number(value) <= MAX_WAIT_MS) {
      waitMs = Number(value); i++;
    } else if ((arg === '--help' || arg === '-h') && !help) help = true;
    else { deps.stderr(`${JSON.stringify({ error: 'invalid arguments', usage })}\n`); return 2; }
  }
  if (help) { deps.stdout(`${usage}\n`); return 0; }
  try {
    if (deps.signal?.aborted) { deps.stderr('{"error":"interrupted"}\n'); return 130; }
    if (waitMs) await deps.wait(waitMs, deps.signal);
    if (deps.signal?.aborted) { deps.stderr('{"error":"interrupted"}\n'); return 130; }
    const [runs, live] = await Promise.all([deps.runs({ runsDir, now: deps.now }), deps.workers({ now: deps.now })]);
    deps.stdout(`${JSON.stringify(laneConsistency(runs, live, new Date(deps.now()).toISOString()))}\n`);
    return 0;
  } catch {
    if (deps.signal?.aborted) { deps.stderr('{"error":"interrupted"}\n'); return 130; }
    deps.stderr('{"error":"unable to produce lane consistency report"}\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => { controller.abort(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try { process.exitCode = await runLaneConsistency(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
