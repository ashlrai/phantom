import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../../cloud/store.js';
import type { DaemonTickPhase } from '../../types.js';
import { readStableRegularFile } from '../../util/stable-file-read.js';

const NAME = 'node-bridge-receipts.json';
const LIMIT = 32;
const MAX_BYTES = 16_384;
const STEPS = [
  'load-config', 'read-pool-config', 'resolve-router', 'resolve-runs-dir', 'check-readiness', 'acquire-lock', 'release-lock',
  'router-view', 'router-withdraw', 'router-recheck', 'router-enqueue', 'read-manifests', 'read-ready',
  'build-plan', 'read-prompt',
] as const;
type Step = typeof STEPS[number];
type Outcome = 'in-flight' | 'ok' | 'error';
interface Receipt { step: Step; startedAt: string; ms: number; outcome: Outcome }
interface Sample { pid: number; startedAt: string; endedAt: string | null; steps: Receipt[] }
export type BridgeTrace = (step: Step) => (outcome: 'ok' | 'error') => void;

export function traceBridgeSync<T>(trace: BridgeTrace | undefined, step: Step, run: () => T): T {
  const end = trace?.(step);
  try { const result = run(); end?.('ok'); return result; }
  catch (error) { end?.('error'); throw error; }
}

export async function traceBridgeWait<T>(trace: BridgeTrace | undefined, step: Step, run: () => Promise<T>): Promise<T> {
  const end = trace?.(step);
  try { const result = await run(); end?.('ok'); return result; }
  catch (error) { end?.('error'); throw error; }
}

export function createBridgeReceipts(pid: number, home = ashlrHome(), now = Date.now) {
  const sample: Sample = { pid, startedAt: new Date(now()).toISOString(), endedAt: null, steps: [] };
  const tmp = join(home, `.${NAME}.${process.pid}.tmp`);
  function publish(): void {
    try {
      writeFileSync(tmp, JSON.stringify(sample), { flag: 'wx', mode: 0o600 });
      try { renameSync(tmp, join(home, NAME)); } finally { try { unlinkSync(tmp); } catch { /* renamed */ } }
    } catch { /* receipts cannot prevent a bridge pass */ }
  }
  const trace: BridgeTrace = step => {
    const started = now();
    const row: Receipt = { step, startedAt: new Date(started).toISOString(), ms: 0, outcome: 'in-flight' };
    if (sample.endedAt !== null) return () => undefined;
    sample.steps.push(row);
    if (sample.steps.length > LIMIT) sample.steps.shift();
    publish();
    return outcome => {
      if (sample.endedAt !== null) return;
      row.outcome = outcome;
      row.ms = Math.max(0, now() - started);
      publish();
    };
  };
  publish();
  return { trace, finish: () => {
    if (sample.endedAt !== null) return;
    sample.endedAt = new Date(now()).toISOString();
    publish();
  } };
}

export function bridgePhasesWithReceipts(
  phases: DaemonTickPhase[], pid: number | null | undefined, daemonStartedAt: string | null | undefined, home = ashlrHome(), now = Date.now(),
) {
  if (!pid) return phases;
  try {
    const read = readStableRegularFile(join(home, NAME), { anchorPath: home, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
    if (!read.ok) return phases;
    const sample = JSON.parse(read.text) as Sample;
    const started = Date.parse(sample.startedAt);
    const daemonStarted = Date.parse(daemonStartedAt ?? '');
    if (sample.pid !== pid || !Number.isFinite(started) || !Number.isFinite(daemonStarted) ||
      started < daemonStarted || !Array.isArray(sample.steps)) return phases;
    const ended = Date.parse(sample.endedAt ?? '');
    const steps = sample.steps.slice(-LIMIT).flatMap(row => {
      if (!row || !STEPS.includes(row.step) || !['in-flight', 'ok', 'error'].includes(row.outcome) ||
        !Number.isFinite(Date.parse(row.startedAt)) || !Number.isFinite(row.ms) || row.ms < 0) return [];
      return [{ step: row.step, startedAt: row.startedAt, outcome: row.outcome,
        ms: row.outcome === 'in-flight' ? Math.max(0, (Number.isFinite(ended) ? ended : now) - Date.parse(row.startedAt)) : row.ms }];
    });
    return phases.map(phase => phase.name !== 'node-bridge' || started < Date.parse(phase.offTick?.since ?? '')
      ? phase : { ...phase, bridgeTiming: { startedAt: sample.startedAt, endedAt: Number.isFinite(ended) ? sample.endedAt : null, steps } });
  } catch { return phases; }
}
