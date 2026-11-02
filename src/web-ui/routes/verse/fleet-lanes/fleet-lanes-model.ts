import { ageText, countText, relativeText, type FleetRuns } from '../ops/ops-runs-model.js';

export function laneBars(runs: FleetRuns) {
  return runs.lanes.map(({ lane, running, target, queued, held, heldReason, tokensLastHour, merged24h }) => ({
    lane, running, target, queued, held, heldReason, tokensLastHour, merged24h,
    fillPct: target > 0 ? Math.max(0, Math.min(100, running / target * 100)) : null,
    tone: held ? 'held' : 'running',
  }));
}

export function formatTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1_000) return String(n);
  const divisor = n < 1_000_000 ? 1_000 : 1_000_000;
  return `${(n / divisor).toFixed(1).replace(/\.0$/, '')}${divisor === 1_000 ? 'k' : 'M'}`;
}

export function burnTotals(runs: FleetRuns) {
  let tokensLastHour: number | null = null;
  let merged24h: number | null = null;
  let reportingLanes = 0;
  for (const lane of runs.lanes) {
    if (lane.tokensLastHour !== null && Number.isFinite(lane.tokensLastHour) && lane.tokensLastHour >= 0) {
      tokensLastHour = (tokensLastHour ?? 0) + lane.tokensLastHour;
      reportingLanes++;
    }
    if (lane.merged24h !== null && Number.isFinite(lane.merged24h) && lane.merged24h >= 0) {
      merged24h = (merged24h ?? 0) + lane.merged24h;
    }
  }
  return { tokensLastHour, reportingLanes, merged24h };
}

export function burnLine(totals: ReturnType<typeof burnTotals>): string {
  if (totals.reportingLanes === 0) return 'No lane reports token burn yet';
  return `${formatTokens(totals.tokensLastHour)} tokens in the last hour across ${totals.reportingLanes} reporting ${totals.reportingLanes === 1 ? 'lane' : 'lanes'}`;
}

export function workerRows(runs: FleetRuns) {
  return [...runs.workers]
    .sort((a, b) => (b.ageSeconds ?? -Infinity) - (a.ageSeconds ?? -Infinity))
    .map((worker) => ({ ...worker, age: ageText(worker.ageSeconds) }));
}

export function repoShort(repo: string): string {
  const name = repo.trim().replace(/^[^/]+\//, '').trim();
  if (!name) return '—';
  return name.length > 32 ? `${name.slice(0, 31)}…` : name;
}

export function isPhantomRepo(repo: string): boolean {
  return /(?:^|\/)phantom$/i.test(repo.trim());
}

export function repoMix(runs: FleetRuns): { total: number; phantom: number; others: Array<{ repo: string; count: number }> } {
  let phantom = 0;
  const counts = new Map<string, number>();
  for (const worker of runs.workers) {
    if (isPhantomRepo(worker.repo)) {
      phantom++;
    } else {
      const repo = repoShort(worker.repo);
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
  }
  const others = [...counts].map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
  return { total: runs.workers.length, phantom, others };
}

export function repoMixLine(mix: ReturnType<typeof repoMix>): string {
  if (mix.total === 0) return '0 workers';
  const others = mix.others.slice(0, 4).map(({ repo, count }) => `${repo} ${count}`).join(', ');
  const more = mix.others.length > 4 ? ` +${mix.others.length - 4} more` : '';
  return `${mix.phantom} of ${mix.total} on phantom${others ? ` · others: ${others}${more}` : ''}`;
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
