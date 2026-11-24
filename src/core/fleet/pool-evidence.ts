/** Local metadata only. Spend and token counts never stand in for a quota percentage. */
import { cpus, freemem, loadavg } from 'node:os';
import { join } from 'node:path';
import { readSource } from './runs-parked-queue.js';
import type { UsageReading } from './usage-history.js';
import type { PaceInput } from './pace-verdict.js';

const POOLS = ['agy', 'claude', 'claude-api', 'codex-cmp', 'codex-local', 'codex-personal', 'cursor', 'devin', 'devin-flash', 'gemini', 'grok', 'zai'];
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const time = (v: unknown): number => {
  const ms = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN;
  return Math.abs(ms) <= 8.64e15 ? ms : NaN;
};
async function json(file: string) {
  try { return object(JSON.parse((await readSource(file, 4096, false)).text)); } catch { return {}; }
}

export async function readPoolSources(root: string, budget: Record<string, unknown>, lanes: Record<string, unknown>, samples: UsageReading[], now: number, statusAt: number | null): Promise<Record<string, PaceInput>> {
  const result: Record<string, PaceInput> = {};
  for (const id of [...new Set([...POOLS, ...Object.keys(budget), ...Object.keys(lanes), ...samples.map(s => s.pool)])].slice(0, 64)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) continue;
    const b = object(budget[id]), u = b.use_it_all === undefined ? b : object(b.use_it_all), lane = object(lanes[id]);
    const file = `queue/${id}-reading.json`, recorded = await json(join(root, file));
    const candidates = [
      ...(statusAt !== null && u.known !== false && b.known !== false && u.stale !== true && b.stale !== true ? [{ pct: u.used_pct ?? b.weekly_used_pct, at: u.observed_at ?? b.observed_at ?? statusAt / 1000, reset: u.reset_at ?? b.reset_at, source: 'queue/status.json' }] : []),
      { pct: recorded.pct, at: recorded.ts, reset: recorded.reset_at, source: file },
      ...samples.filter(s => s.pool === id).map(s => ({ pct: s.used_pct, at: s.observed_at, reset: s.reset_at, source: 'metrics/usage-history.json' })),
    ].filter(s => number(s.pct) !== null && Number(s.pct) <= 1000 && Number.isFinite(time(s.at)) && time(s.at) <= now)
      .sort((a, b) => time(b.at) - time(a.at));
    const newest = candidates.find(s => now - time(s.at) <= 24 * 3_600_000 && (!Number.isFinite(time(s.reset)) || time(s.reset) > now)) ?? candidates[0];
    const fromStatus = newest?.source === 'queue/status.json';
    const target = number(lane.target), running = number(lane.running);
    result[id] = { id, usedPct: newest ? Number(newest.pct) : null, hoursLeft: fromStatus ? number(u.hours_to_reset) : null, burnPctPerHour: fromStatus ? number(u.burn_pct_per_hour) : null,
      resetAt: newest && Number.isFinite(time(newest.reset)) ? new Date(time(newest.reset)).toISOString() : null,
      observedAt: newest ? new Date(time(newest.at)).toISOString() : null,
      source: newest?.source ?? `${file} or metrics/usage-history.json; metrics/jobs.jsonl records lane spend, not remaining quota`,
      ...(id === 'codex-local' || id === 'devin-flash' ? { headroom: { slots: lane.held === true || target === 0 || (number(lane.pause_new_until) ?? 0) > now / 1000 ? 0 : target === null || running === null ? null : Math.max(0, target - running),
        ...(id === 'codex-local' ? { ramBytes: freemem(), cpuCores: Math.max(0, cpus().length - loadavg()[0]) } : {}) } } : {}),
    };
  }
  return result;
}
