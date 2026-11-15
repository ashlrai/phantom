import type { ComputeNode } from '../../../../core/fleet/compute-view.js';

type Stats = NonNullable<ComputeNode['stats']>;
export const fresh = (at: number | null | undefined, now: number) =>
  at != null && now >= at && now - at <= 90_000;

/** CPU counters are cumulative: a single sample is never a percentage. */
export function cpuPercent(previous: Stats | null, current: Stats | null): number | null {
  if (!previous || !current || current.sampledAtMs <= previous.sampledAtMs ||
      current.sampledAtMs - previous.sampledAtMs > 90_000 || current.uptimeSeconds <= previous.uptimeSeconds ||
      !current.cores.length || current.cores.length !== previous.cores.length) return null;
  let total = 0, idle = 0;
  for (let i = 0; i < current.cores.length; i++) {
    const dt = current.cores[i]!.total - previous.cores[i]!.total;
    const di = current.cores[i]!.idle - previous.cores[i]!.idle;
    if (dt <= 0 || di < 0 || di > dt) return null;
    total += dt; idle += di;
  }
  return 100 * (1 - idle / total);
}

export const number = (n: number | null | undefined, unit = '') =>
  n == null || !Number.isFinite(n) ? 'unknown' : `${Math.round(n * 10) / 10}${unit}`;
export const bytes = (n: number | null | undefined) => n == null ? 'unknown' : number(n / 1024 ** 3, ' GiB');
export const elapsed = (seconds: number | null) => seconds == null ? 'unknown' :
  seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
export function age(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && now >= at ? `${elapsed((now - at) / 1000)} ago` : 'unknown';
}
export const prLink = (url: string | null) =>
  url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url) ? url : null;
