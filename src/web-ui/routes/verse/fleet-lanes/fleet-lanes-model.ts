import { ageText, countText, relativeText, type FleetRuns } from '../ops/ops-runs-model.js';

export function laneBars(runs: FleetRuns) {
  return runs.lanes.map(({ lane, running, target, queued, held, heldReason }) => ({
    lane, running, target, queued, held, heldReason,
    fillPct: target > 0 ? Math.max(0, Math.min(100, running / target * 100)) : null,
    tone: held ? 'held' : 'running',
  }));
}

export function workerRows(runs: FleetRuns) {
  return [...runs.workers]
    .sort((a, b) => (b.ageSeconds ?? -Infinity) - (a.ageSeconds ?? -Infinity))
    .map((worker) => ({ ...worker, age: ageText(worker.ageSeconds) }));
}

export function headline(runs: FleetRuns | null, nowMs: number): string {
  const running = runs ? String(runs.lanes.reduce((sum, lane) => sum + lane.running, 0)) : '—';
  const target = runs ? String(runs.lanes.reduce((sum, lane) => sum + lane.target, 0)) : '—';
  const tick = runs?.lastTick ?? null;
  const at = tick === null ? NaN : Date.parse(tick);
  const elapsed = (nowMs - at) / 1000;
  const tickText = Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 60
    ? `${Math.floor(elapsed)} s ago` : relativeText(tick, nowMs);
  return `${running} running · ${target} target · ${countText(runs?.mergesLastHour.count ?? null)} merged last hour · tick ${tickText}`;
}
