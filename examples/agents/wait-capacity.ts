#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFleetRunsDirState, type FleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';
import { scrubSecrets } from '../../src/core/util/scrub.js';

const MAX_TIMEOUT_MS = 3_600_000;
const POLL_MS = 1_000;
const usage = 'Usage: npx tsx examples/agents/wait-capacity.ts --lane NAME --timeout-ms N [--runs-dir PATH]';
type Observation = {
  state: 'available' | 'blocked' | 'unknown';
  observedAt: string | null; lastTick: string | null;
  running: number | null; target: number | null; slots: number | null;
};
type Dependencies = {
  read: typeof readFleetRunsDirState;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveWait(); }, ms);
    function abort() { clearTimeout(timer); reject(new Error('aborted')); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Race even an unexpectedly stalled reader against cancellation and the deadline.
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolveValue, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const abort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolveValue(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function observe(snapshot: FleetRunsDirState, laneName: string): Observation {
  const unknown: Observation = { state: 'unknown', observedAt: snapshot.generatedAt, lastTick: snapshot.lastTick,
    running: null, target: null, slots: null };
  if (snapshot.sources.status !== 'healthy' || !snapshot.lastTick || typeof snapshot.paused !== 'boolean') return unknown;
  const lane = snapshot.lanes.find(row => row.lane === laneName);
  if (!lane || !Number.isSafeInteger(lane.running) || lane.running < 0 ||
      !Number.isSafeInteger(lane.target) || lane.target < 0 || typeof lane.held !== 'boolean') return unknown;
  const slots = Math.max(0, lane.target - lane.running);
  return { state: !snapshot.paused && !lane.held && slots > 0 ? 'available' : 'blocked',
    observedAt: snapshot.generatedAt, lastTick: snapshot.lastTick, running: lane.running, target: lane.target, slots };
}

/** Wait for an observation, without reserving a slot or changing fleet state. */
export async function runWaitCapacity(args: string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const deps: Dependencies = { read: readFleetRunsDirState, now: Date.now, wait,
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text), ...overrides };
  const values = new Map<string, string>();
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { deps.stdout(`${usage}\n`); return 0; }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--lane', '--timeout-ms', '--runs-dir'].includes(key) || !value || value.startsWith('-') || values.has(key)) {
      deps.stderr(`${JSON.stringify({ error: 'invalid_arguments', usage })}\n`); return 2;
    }
    values.set(key, value);
  }
  const lane = values.get('--lane') ?? '';
  const timeoutText = values.get('--timeout-ms') ?? '';
  const timeout = Number(timeoutText);
  const runsDir = values.get('--runs-dir');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(lane) || scrubSecrets(lane) !== lane ||
      !/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeout) || timeout > MAX_TIMEOUT_MS ||
      (runsDir !== undefined && (runsDir.length > 4096 || /\p{Cc}/u.test(runsDir)))) {
    deps.stderr(`${JSON.stringify({ error: 'invalid_arguments', usage })}\n`); return 2;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  deps.signal?.addEventListener('abort', cancel, { once: true });
  if (deps.signal?.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const deadline = deps.now() + timeout;
  let observation: Observation = { state: 'unknown', observedAt: null, lastTick: null, running: null, target: null, slots: null };
  try {
    while (!controller.signal.aborted && deps.now() < deadline) {
      try {
        const snapshot = await untilAbort(deps.read({ runsDir, now: deps.now }), controller.signal);
        if (controller.signal.aborted || deps.now() >= deadline) break;
        observation = observe(snapshot, lane);
        if (observation.state === 'available') {
          deps.stdout(`${JSON.stringify({ v: 1, result: 'available', lane, observation })}\n`);
          return 0;
        }
      } catch {
        if (controller.signal.aborted) break;
        observation = { state: 'unknown', observedAt: null, lastTick: null, running: null, target: null, slots: null };
      }
      const remaining = deadline - deps.now();
      if (remaining <= 0) break;
      await untilAbort(deps.wait(Math.min(POLL_MS, remaining), controller.signal), controller.signal);
    }
  } catch {
    if (!controller.signal.aborted) { deps.stderr(`${JSON.stringify({ error: 'wait_failed' })}\n`); return 1; }
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
  if (deps.signal?.aborted && !timedOut) { deps.stderr(`${JSON.stringify({ error: 'cancelled' })}\n`); return 130; }
  deps.stderr(`${JSON.stringify({ error: 'timeout', lane, observation })}\n`);
  return 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  let signalExit = 130;
  const onInt = () => { signalExit = 130; controller.abort(); };
  const onTerm = () => { signalExit = 143; controller.abort(); };
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    const code = await runWaitCapacity(process.argv.slice(2), { signal: controller.signal });
    process.exitCode = code === 130 ? signalExit : code;
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
}
