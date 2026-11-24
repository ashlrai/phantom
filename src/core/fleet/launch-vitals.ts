import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTelemetryFile } from '../resources/telemetry.js';

export interface LaunchVitals {
  reason: string | null;
  nextWindowSeconds: number | null;
  queued: number | null;
  lanes: Array<{ lane: string; running: number | null; target: number | null; queued: number | null }>;
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Missing or invalid observations stay unknown; never infer permission to launch. */
export async function readLaunchVitals(runs = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): Promise<LaunchVitals> {
  const read = async (name: string): Promise<unknown> => {
    const text = await readTelemetryFile(join(runs, 'queue', name));
    try { return text === null ? null : JSON.parse(text) as unknown; } catch { return null; }
  };
  const [status] = await Promise.all([read('status.json'), read('admission-ctl.json')]);
  const laneRecord = record(record(status).lanes);
  const lanes = Object.entries(laneRecord).filter(([name]) => /^[a-z][a-z0-9-]{1,30}$/.test(name)).slice(0, 128)
    .map(([lane, value]) => ({ lane, running: count(record(value).running), target: count(record(value).target), queued: count(record(value).queued) }));
  const complete = Object.keys(laneRecord).length === lanes.length && lanes.every(lane => lane.queued !== null);
  return { reason: null, nextWindowSeconds: null, queued: status && record(status).lanes && complete ? lanes.reduce((sum, lane) => sum + lane.queued!, 0) : null, lanes };
}
