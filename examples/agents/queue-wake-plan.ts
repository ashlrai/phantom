#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readFleetQueue, type FleetQueueV1 } from '../../src/core/fleet/runs-parked-queue.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';
import { sanitizePublicJson } from '../../src/core/util/public-json.js';

type Dependencies = {
  readQueue: typeof readFleetQueue;
  readRuns: typeof readFleetRunsDirState;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** Join observations, not admission decisions. The caller limits the returned groups. */
export function queueWakePlan(queue: FleetQueueV1, runs: FleetRunsDirState, generatedAt: string, limit: number) {
  const lanes = new Map(runs.lanes.map(lane => [lane.lane, lane]));
  const reliable = queue.sources.ready === 'healthy' && runs.sources.status === 'healthy';
  return {
    v: 1, generatedAt,
    observation: {
      queue: { generatedAt: queue.generatedAt, sources: queue.sources, total: queue.total, ready: queue.ready, parked: queue.parked, malformed: queue.malformed },
      runs: { generatedAt: runs.generatedAt, lastTick: runs.lastTick, sourceState: runs.sourceState, sources: runs.sources, paused: runs.paused, switches: runs.switches },
    },
    groupCount: queue.groups.length,
    truncated: queue.groups.length > limit,
    groups: queue.groups.slice(0, limit).map(group => {
      const lane = group.lane === null ? undefined : lanes.get(group.lane);
      const classification = !reliable || !lane ? 'unknown'
        : lane.held ? 'held' : lane.running >= lane.target ? 'no-capacity' : 'capacity-available';
      return {
        ...group, classification,
        status: lane ? { held: lane.held, heldReason: lane.heldReason, running: lane.running, target: lane.target } : null,
      };
    }),
  };
}

/** One bounded, read-only observation; dependencies are injectable for embedding and tests. */
export async function runQueueWakePlan(args: string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const deps: Dependencies = {
    readQueue: readFleetQueue, readRuns: readFleetRunsDirState, now: Date.now,
    wait: async (ms, signal) => { await delay(ms, undefined, { signal }); },
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text), ...overrides,
  };
  const error = (code: string) => deps.stderr(`${JSON.stringify({ error: code })}\n`);
  let runsDir: string | undefined;
  let limit = 100, waitMs = 0;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    const value = args[++i];
    if (seen.has(key) || value === undefined) { error('invalid_arguments'); return 2; }
    seen.add(key);
    if (key === '--runs-dir' && value.length > 0 && value.length <= 4096 && !value.startsWith('-')) runsDir = value;
    else if (key === '--limit' && /^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(value)) limit = Number(value);
    else if (key === '--wait-ms' && /^(?:0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= 30000) waitMs = Number(value);
    else { error('invalid_arguments'); return 2; }
  }
  const controller = new AbortController();
  let interrupted = 0;
  const onInt = () => { interrupted = 130; controller.abort(); };
  const onTerm = () => { interrupted = 143; controller.abort(); };
  try {
    if (waitMs) {
      process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
      try { await deps.wait(waitMs, controller.signal); }
      finally { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); }
      if (interrupted) { error('interrupted'); return interrupted; }
    }
    const now = deps.now();
    const [queue, runs] = await Promise.all([
      deps.readQueue({ runsDir, now: () => now }), deps.readRuns({ runsDir, now: () => now }),
    ]);
    deps.stdout(`${JSON.stringify(sanitizePublicJson(queueWakePlan(queue, runs, new Date(now).toISOString(), limit)))}\n`);
    return Object.values(queue.sources).every(s => s === 'healthy') && runs.sourceState === 'healthy' ? 0 : 1;
  } catch {
    error(interrupted ? 'interrupted' : 'unavailable');
    return interrupted || 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runQueueWakePlan(process.argv.slice(2));
}
