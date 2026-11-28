import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTelemetryFile } from '../resources/telemetry.js';
import { admissionStatus } from './admission-status.js';

export interface LaunchVitals {
  reason: string | null;
  nextWindowSeconds: number | null;
  queued: number | null;
  lanes: Array<{ lane: string; running: number | null; target: number | null; queued: number | null }>;
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const DISPATCHER_MAX_AGE_MS = 60_000; // Two 30-second dispatcher ticks.

/** Missing or invalid observations stay unknown; never infer permission to launch. */
export async function readLaunchVitals(
  runs = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'),
  now = Date.now(),
): Promise<LaunchVitals> {
  const [status, guard] = await Promise.all([
    readTelemetryFile(join(runs, 'queue', 'status.json')).then(text => {
      try { return text === null ? null : JSON.parse(text) as unknown; } catch { return null; }
    }),
    readTelemetryFile(join(runs, 'queue', 'admission-ctl.json')),
  ]);
  const admission = admissionStatus(guard, now);
  const dispatcher = record(status);
  const tickMs = typeof dispatcher.last_tick === 'string' ? Date.parse(dispatcher.last_tick) : NaN;
  const fresh = tickMs <= now && now - tickMs <= DISPATCHER_MAX_AGE_MS;
  const laneRecord = record(dispatcher.lanes);
  const lanes = Object.entries(laneRecord).filter(([name]) => /^[a-z][a-z0-9-]{1,30}$/.test(name)).slice(0, 128)
    .map(([lane, value]) => {
      const row = fresh ? record(value) : {};
      return { lane, running: count(row.running), target: count(row.target), queued: count(row.queued) };
    });
  const complete = fresh && laneRecord === dispatcher.lanes &&
    Object.keys(laneRecord).length === lanes.length && lanes.every(lane => lane.queued !== null);
  return {
    reason: admission.state === 'unknown' ? null : admission.reason,
    nextWindowSeconds: admission.state === 'open' || admission.state === 'settling' ? admission.nextStartSeconds : null,
    queued: complete ? count(lanes.reduce((sum, lane) => sum + lane.queued!, 0)) : null,
    lanes,
  };
}
