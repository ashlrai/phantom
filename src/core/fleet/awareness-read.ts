/** Fixed, bounded local reads. Mirrors are observations only; dispatch uses the witness transaction. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { parseState, type NodesState } from '../drive/nodes/state.js';
import { projectFleetAwareness } from './awareness.js';

const MAX_BYTES = 2 * 1024 * 1024;
async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted();
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid telemetry file');
    const data = Buffer.alloc(stat.size + 1);
    signal.throwIfAborted();
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    signal.throwIfAborted();
    if (bytesRead !== stat.size) throw new Error('Changed telemetry file');
    return JSON.parse(data.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

export async function readFleetAwareness(options: { home?: string; runsDir?: string; now?: number; signal?: AbortSignal;
  read?: typeof readJson; deadlineMs?: number } = {}) {
  const home = options.home ?? ashlrHome(), runs = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const read = options.read ?? readJson, now = options.now ?? Date.now();
  const phase = async (name: string, path: string, parse: (v: unknown) => unknown) => {
    const controller = new AbortController(), started = performance.now();
    const abort = () => controller.abort();
    const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Deadline')), { once: true }));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, Math.max(1, Math.min(1_000, options.deadlineMs ?? 250)));
    let value: unknown = null, status: 'ok' | 'unavailable' | 'timeout' = 'ok';
    try { value = await Promise.race([Promise.resolve().then(() => read(path, controller.signal)).then(parse), stopped]); }
    catch { status = controller.signal.aborted ? 'timeout' : 'unavailable'; }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    return { value, record: { name, status, durationMs: Math.round(performance.now() - started) } };
  };
  const validState = (v: unknown) => { const s = parseState(v);
    if (s.observedAt > now || s.nodes.length > 512 || s.jobs.length > 10_000) throw new Error('Oversized telemetry'); return s; };
  const phases = await Promise.all([
    phase('pool', join(home, 'node-pool', 'nodes.json'), validState),
    phase('mirror', join(home, 'node-pool', 'primary-mirror.json'), validState),
    phase('registry', join(home, 'nodes', 'nodes.json'), validState),
    phase('lanes', join(runs, 'queue', 'status.json'), v => v),
  ]);
  // Select one coherent fencing snapshot; never merge claims from different epochs.
  const state = phases.slice(0, 3).map(p => p.value as NodesState | null).filter((s): s is NodesState => s !== null)
    .sort((a, b) => Number(!!b.pool) - Number(!!a.pool) || b.observedAt - a.observedAt || b.sequence - a.sequence)[0] ?? null;
  return { ...projectFleetAwareness(state, now, phases[3]!.value), phases: phases.map(p => p.record) };
}
