import type { FleetUsageV1 } from './fleet-usage-model.js';

const HOUR = 3_600_000;
const at = (nowMs: number, hours: number) => new Date(nowMs + hours * HOUR).toISOString();

/** One lane per state the panel renders: high waste, held, stale, unknown, normal. */
export function FLEET_USAGE_FIXTURE(nowMs: number): FleetUsageV1 {
  const base = { window: 'weekly' as const, held: false, heldReason: null, stale: false, sourceAgeSec: 60 };
  return {
    schema: 'fleet-usage.v1', generatedAt: new Date(nowMs).toISOString(),
    lanes: [
      { ...base, lane: 'claude', usedPct: 62, resetAt: at(nowMs, 52), burnPctPerHour: 0.6, running: 4, target: 5, ceiling: 8, queued: 3 },
      { ...base, lane: 'claude-api', window: 'credits', usedPct: 18, resetAt: at(nowMs, 30), burnPctPerHour: 0.1, running: 1, target: 2, ceiling: 4, queued: 0 },
      { ...base, lane: 'codex-cmp', usedPct: 12, resetAt: at(nowMs, 20), burnPctPerHour: 0.2, running: 2, target: 6, ceiling: 8, queued: 5 },
      { ...base, lane: 'codex-personal', usedPct: 41, resetAt: at(nowMs, 70), burnPctPerHour: 0.5, running: 2, target: 2, ceiling: 4, queued: 1 },
      { ...base, lane: 'codex-local', window: 'none', usedPct: null, resetAt: null, burnPctPerHour: null, running: 3, target: 4, ceiling: 6, queued: 0 },
      { ...base, lane: 'devin', held: true, heldReason: 'ACU budget guard', usedPct: 30, resetAt: at(nowMs, 90), burnPctPerHour: 0, running: 0, target: 2, ceiling: 3, queued: 4 },
      { ...base, lane: 'gemini', usedPct: 55, resetAt: at(nowMs, 12), burnPctPerHour: 1.1, running: 3, target: 3, ceiling: 4, queued: 2, stale: true, sourceAgeSec: 5400 },
      { ...base, lane: 'zai', usedPct: 70, resetAt: at(nowMs, 26), burnPctPerHour: 0.9, running: 2, target: 2, ceiling: 3, queued: 0 },
      { ...base, lane: 'omlx-local', window: 'none', usedPct: null, resetAt: null, burnPctPerHour: null, running: 1, target: 2, ceiling: 2, queued: 0, sourceAgeSec: null },
    ],
  };
}
