import { cpus, loadavg } from 'node:os';

export interface HostLoad {
  load1: number | null; load5: number | null; load15: number | null;
  cores: number | null; ratio: number | null;
}

export function readHostLoad(deps: { loadavg: () => number[]; cpus: () => unknown[] } = { loadavg, cpus }): HostLoad {
  let loads: number[] = [];
  let cores: number | null = null;
  try { loads = deps.loadavg(); } catch { /* The load reading is unavailable. */ }
  try { const count = deps.cpus().length; if (count > 0) cores = count; } catch { /* Core count is unavailable. */ }
  const valid = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const load1 = valid(loads[0]);
  const rounded = load1 !== null && cores !== null ? Math.round((load1 / cores) * 10) / 10 : null;
  return { load1, load5: valid(loads[1]), load15: valid(loads[2]), cores, ratio: rounded !== null && Number.isFinite(rounded) ? rounded : null };
}

export function hostLoadTone(ratio: number | null): 'unknown' | 'ok' | 'warn' | 'bad' {
  return ratio === null ? 'unknown' : ratio < 1.5 ? 'ok' : ratio < 4 ? 'warn' : 'bad';
}

export function describeHostLoad(load: HostLoad | null | undefined): string {
  return load?.load1 == null || load.cores == null || load.ratio == null
    ? 'Load unknown' : `Load ${load.load1} on ${load.cores} cores (${load.ratio.toFixed(1)}×)`;
}
