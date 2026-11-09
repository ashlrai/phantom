/** Advisory memory shedding; no dispatcher settings or jobs are changed. */
export interface ShedLane {
  lane: string;
  kind: 'local' | 'cloud' | 'unknown';
  running: number | null;
  merged: number | null;
  ramGb: number | null;
  mergedPerGb: number | null;
  recommendation: 'shed' | 'keep' | 'unknown';
}

export interface ShedPlan {
  schema: 'fleet.shed-plan.v1';
  readOnly: true;
  pressure: 'high' | 'normal' | 'unknown';
  memFreePct: number | null;
  swapGb: number | null;
  lanes: ShedLane[];
  nextAction: string;
  gaps: string[];
}

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const nonnegative = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v: unknown): number | null => Number.isSafeInteger(v) ? nonnegative(v) : null;
const cloud = new Set(['codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'cursor', 'gemini', 'zai', 'agy', 'grok']);

export function planFleetShed(input: unknown): ShedPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid status');
  const status = object(input);
  if (!status.lanes || typeof status.lanes !== 'object' || Array.isArray(status.lanes)) throw new Error('Invalid lanes');
  const free = nonnegative(status.mem_free_pct);
  const memFreePct = free !== null && free <= 100 ? free : null;
  const swapGb = nonnegative(status.swap_gb);
  // Match dispatchd's free-memory fallback. Swap is reported, not used as a threshold.
  const pressure = memFreePct === null ? 'unknown' : memFreePct <= 30 ? 'high' : 'normal';
  const byLane = object(object(status.rollup_24h).by_lane);
  const lanes: ShedLane[] = Object.entries(object(status.lanes)).filter(([name]) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)).map(([lane, raw]) => {
    const row = object(raw);
    const running = count(row.running);
    const merged = count(object(byLane[lane]).merged);
    // Optional total RAM for the lane, in GiB; absent in current dispatcher snapshots.
    const ram = nonnegative(row.ram_gb);
    const ramGb = ram !== null && ram > 0 ? ram : null;
    const kind = lane === 'local' || lane.endsWith('-local') ? 'local' : cloud.has(lane) ? 'cloud' : 'unknown';
    return { lane, kind, running, merged, ramGb, mergedPerGb: merged !== null && ramGb !== null ? merged / ramGb : null, recommendation: 'unknown' };
  });
  const priority = { local: 0, cloud: 1, unknown: 2 };
  lanes.sort((a, b) => priority[a.kind] - priority[b.kind] || (a.mergedPerGb ?? Infinity) - (b.mergedPerGb ?? Infinity) || a.lane.localeCompare(b.lane));
  const candidate = pressure === 'high' ? lanes.find(l => l.kind !== 'unknown' && l.running !== null && l.running > 0) : undefined;
  for (const lane of lanes) {
    if (pressure !== 'unknown' && lane.kind !== 'unknown' && lane.running !== null) lane.recommendation = lane === candidate ? 'shed' : 'keep';
  }
  const gaps = ['This plan is advisory; the dispatcher does not apply it or guarantee admission.'];
  if (lanes.some(l => l.ramGb === null)) gaps.push('Per-lane RAM is missing; efficiency and ordering within a lane kind may be unknown.');
  if (lanes.some(l => l.kind === 'unknown' || l.running === null || l.merged === null)) gaps.push('Some lane kind, running count or merge count is unknown.');
  const nextAction = candidate ? `Reduce ${candidate.lane} admission first, then check memory again.` : pressure === 'unknown' ? 'Check the memory reading before changing admission.' : pressure === 'high' ? 'Check running lanes and memory before changing admission.' : 'Keep admission unchanged and monitor memory.';
  return { schema: 'fleet.shed-plan.v1', readOnly: true, pressure, memFreePct, swapGb, lanes, nextAction, gaps };
}
