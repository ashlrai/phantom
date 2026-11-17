import { join } from 'node:path';
import { readSource } from './runs-parked-queue.js';

export interface LaunchCost {
  schema: 'fleet.launch-cost.v1'; lane: string; launchId: string; startedAt: string | null;
  windowSeconds: 60; sampledSeconds: number; samples: number;
  peakProcesses: number | null; meanCpuPercentOneCore: number | null; peakCpuPercentOneCore: number | null;
  status: 'measured' | 'partial' | 'unknown';
}
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
function parse(value: unknown): LaunchCost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const metrics = [r.peakProcesses, r.meanCpuPercentOneCore, r.peakCpuPercentOneCore];
  if (r.schema !== 'fleet.launch-cost.v1' || !id(r.lane) || !id(r.launchId) ||
    (r.startedAt !== null && (typeof r.startedAt !== 'string' || !Number.isFinite(Date.parse(r.startedAt)))) || r.windowSeconds !== 60 ||
    !count(r.sampledSeconds) || r.sampledSeconds > 60 || !Number.isSafeInteger(r.samples) || Number(r.samples) < 0 ||
    !['measured', 'partial', 'unknown'].includes(String(r.status)) || metrics.some(v => v !== null && !count(v)) ||
    (r.peakProcesses !== null && !Number.isSafeInteger(r.peakProcesses)) ||
    (r.status === 'unknown' && metrics.some(v => v !== null)) ||
    (r.status !== 'unknown' && (r.startedAt === null || metrics.some(v => v === null) || Number(r.samples) < 1 || Number(r.peakProcesses) < 1)) ||
    // ps start identity has one-second precision; preserve actual coverage, allowing first-second attachment.
    (r.status === 'measured' && (r.sampledSeconds < 59 || Number(r.samples) < 12)) ||
    (count(r.meanCpuPercentOneCore) && count(r.peakCpuPercentOneCore) && r.meanCpuPercentOneCore > r.peakCpuPercentOneCore)) return null;
  // Project the closed metadata schema; arbitrary ledger fields never reach JSON output.
  return { schema: 'fleet.launch-cost.v1', lane: r.lane, launchId: r.launchId, startedAt: r.startedAt === null ? null : new Date(r.startedAt as string).toISOString(),
    windowSeconds: 60, sampledSeconds: r.sampledSeconds, samples: r.samples as number,
    peakProcesses: r.peakProcesses as number | null, meanCpuPercentOneCore: r.meanCpuPercentOneCore as number | null,
    peakCpuPercentOneCore: r.peakCpuPercentOneCore as number | null, status: r.status as LaunchCost['status'] };
}
export async function readLaunchCosts(runsDir: string) {
  const source = await readSource(join(runsDir, 'metrics', 'launch-cost.jsonl'), 256 * 1024, true);
  const launches: LaunchCost[] = [];
  for (const line of source.text.split(/\r?\n/).filter(Boolean)) {
    let row: LaunchCost | null = null;
    try { row = parse(JSON.parse(line)); } catch { /* Invalid evidence remains unknown. */ }
    if (row) launches.push(row); else source.state = 'degraded';
  }
  const recent = launches.slice(-100);
  return { source: source.state, state: recent.some(row => row.status !== 'unknown') ? 'known' as const : 'unknown' as const, launches: recent };
}
