/**
 * The host.top.v1 report (`phm host top --json`) and its plain words. Browser-safe: no node imports,
 * so the This Mac card and the CLI share the same types and the same lines.
 */
import type { HostLoadItem } from './host-load.js';

export const HOST_TOP_SCHEMA = 'host.top.v1';
export type HostTopAction = 'quit' | 'stop' | 'wait' | 'lower-lanes';
const round1 = (value: number): number => Math.round(value * 10) / 10;
const QUIT_UNUSED = 'quit it if you are not using it';
/** `says` starts the plain line ("Docker is using ..."); `advice` ends it. No advice means nothing is ever suggested. */
export const HOST_TOP_BUCKETS = [
  { id: 'fleet-workers', name: 'Fleet workers', says: 'Fleet workers are', action: 'lower-lanes', advice: 'that is the fleet\'s own work, so lower a lane target if you need the Mac back' },
  { id: 'local-models', name: 'Local model server', says: 'The local model server is', action: 'stop', advice: 'stop it if no lane needs it' },
  { id: 'docker', name: 'Docker', says: 'Docker is', action: 'quit', advice: 'quit it if no lane needs it' },
  { id: 'claude', name: 'Claude', says: 'Claude is', action: 'quit', advice: QUIT_UNUSED },
  { id: 'codex', name: 'Codex', says: 'Codex is', action: 'quit', advice: QUIT_UNUSED },
  { id: 'chatgpt', name: 'ChatGPT', says: 'ChatGPT is', action: 'quit', advice: QUIT_UNUSED },
  { id: 'cursor', name: 'Cursor', says: 'Cursor is', action: 'quit', advice: QUIT_UNUSED },
  { id: 'grok', name: 'Grok', says: 'Grok is', action: 'quit', advice: QUIT_UNUSED },
  { id: 'chrome', name: 'Chrome', says: 'Chrome is', action: 'quit', advice: 'close tabs, or quit it if you are not using it' },
  { id: 'phantom', name: 'Phantom', says: 'Phantom is', action: null, advice: null },
  { id: 'other-apps', name: 'Other apps', says: 'Other apps are', action: 'quit', advice: 'quit the ones you are not using' },
  { id: 'indexing', name: 'Spotlight and indexing', says: 'Spotlight and indexing are', action: 'wait', advice: 'it usually finishes on its own, so wait' },
  { id: 'system', name: 'macOS', says: 'macOS is', action: null, advice: null },
  { id: 'other', name: 'Other', says: 'Other processes are', action: null, advice: null },
] as const satisfies ReadonlyArray<{ id: string; name: string; says: string; action: HostTopAction | null; advice: string | null }>;
export type HostTopBucketId = (typeof HOST_TOP_BUCKETS)[number]['id'];
export interface HostTopBucket extends HostLoadItem {
  id: HostTopBucketId;
  /** The larger of its share of all cores and its share of memory, 0 to 100. Buckets are sorted by it, biggest first. */
  sharePercent: number;
  /** The three busiest jobs (fleet workers), apps (other apps) or commands. */
  items: HostLoadItem[];
}
export interface HostTopReport {
  schema: typeof HOST_TOP_SCHEMA; version: 1; generatedAt: string;
  /** known: every input was read. partial: see gaps. unknown: no process list, so every bucket is empty. */
  state: 'known' | 'partial' | 'unknown';
  host: {
    load1: number | null; load5: number | null; cores: number | null;
    pressure: 'normal' | 'warning' | 'critical' | null; swapUsedGb: number | null; memoryFreePercent: number | null;
    /** Where free disk is heading. An older server may still omit it. */
    disk?: HostDiskTrend;
  };
  /** Exactly the sum of the buckets. cpuPercent is ps CPU, where 100 is one busy core. */
  totals: { cpuPercent: number; rssMb: number; processes: number };
  /** Every bucket, biggest first; empty ones last. */
  buckets: HostTopBucket[];
  /** Name of the app in front, or null when it is unknown. */
  frontApp: string | null;
  biggest: HostTopBucketId | null;
  /** `line` is the plain words shown everywhere. `bucket` and `action` name what is suggested, or null for nothing. */
  suggestion: { line: string; bucket: HostTopBucketId | null; action: HostTopAction | null };
  gaps: string[];
}

/** The free-disk floor the trend measures to, in GB: the same reuse-only line as the fleet's disk guards. */
export const HOST_DISK_FLOOR_GB = 100;
/** Reaching the floor in fewer hours than this is a warning. */
export const HOST_DISK_WARN_HOURS = 12;
/** A change smaller than this many GB per hour reads as holding steady. */
const HOST_DISK_FLAT_GB_PER_HOUR = 0.1;

/** One free-disk reading: `at` is epoch seconds, `freeGb` is decimal GB. */
export interface HostDiskSample { at: number; freeGb: number }

export interface HostDiskTrend {
  /** The newest reading, or null when nothing was readable. */
  freeGb: number | null;
  /** How fast free disk is changing in GB per hour: positive falling, negative rising, null when unknown. */
  gbPerHour: number | null;
  /** The last run of readings said in plain words; `unknown` when there are fewer than two. */
  direction: 'falling' | 'flat' | 'rising' | 'unknown';
  /** The floor free disk is measured against, in GB. */
  floorGb: number;
  /** Hours until free disk reaches the floor: 0 when already at or below it, null when unknown or not falling. */
  hoursToFloor: number | null;
  /** The warning horizon that `warning` is measured against, in hours. */
  warnUnderHours: number;
  warning: 'below-floor' | 'under-warn-hours' | null;
  /** How many readings the trend used, the live reading included. */
  samples: number;
  /** When the newest reading was taken; null when nothing was readable. */
  observedAt: string | null;
}

/**
 * The free-disk trend over the readings given: GB per hour, hours to the floor, and whether that is too soon.
 * The trend is the last run of readings moving one way, so a cleanup that raises free disk starts a new run
 * instead of hiding a fall behind it. Junk rows (negative, infinite, or future-dated) are ignored; the last
 * row wins for a repeated timestamp. Pure: no clock, no disk, no writes.
 */
export function diskTrend(samples: readonly HostDiskSample[], floorGb: number, now: number): HostDiskTrend {
  const trend: HostDiskTrend = { freeGb: null, gbPerHour: null, direction: 'unknown', floorGb, hoursToFloor: null,
    warnUnderHours: HOST_DISK_WARN_HOURS, warning: null, samples: 0, observedAt: null };
  const rows = new Map<number, number>();
  for (const { at, freeGb } of samples) {
    if (!Number.isFinite(at) || !Number.isFinite(freeGb) || at < 0 || freeGb < 0 || at * 1000 > now) continue;
    rows.set(at, freeGb);
  }
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  trend.samples = sorted.length;
  const newest = sorted.at(-1);
  if (!newest) return trend;
  trend.freeGb = round1(newest[1]);
  trend.observedAt = new Date(newest[0] * 1000).toISOString();
  let start = sorted.length - 1;
  if (start > 0) {
    // Walk back while the readings keep moving the way the newest step moved (equals keep the run going).
    const rising = sorted[start - 1]![1] <= sorted[start]![1];
    while (start > 0 && (rising ? sorted[start - 1]![1] <= sorted[start]![1] : sorted[start - 1]![1] >= sorted[start]![1])) start--;
    const first = sorted[start]!;
    const perHour = (first[1] - newest[1]) * 3600 / (newest[0] - first[0]);
    if (Math.abs(perHour) < HOST_DISK_FLAT_GB_PER_HOUR) trend.direction = 'flat';
    else { trend.gbPerHour = Math.round(perHour * 100) / 100; trend.direction = perHour > 0 ? 'falling' : 'rising'; }
  }
  if (trend.freeGb <= floorGb) { trend.hoursToFloor = 0; trend.warning = 'below-floor'; }
  else if (trend.direction === 'falling' && trend.gbPerHour !== null) {
    trend.hoursToFloor = Math.round((trend.freeGb - floorGb) / trend.gbPerHour * 10) / 10;
    if (trend.hoursToFloor < HOST_DISK_WARN_HOURS) trend.warning = 'under-warn-hours';
  }
  return trend;
}

const diskHoursWords = (hours: number): string =>
  hours < 1 ? 'under an hour' : `about ${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} hours`;

/** The free-disk part of the host line. Unknown is said as unknown. */
export function describeHostDisk(disk: HostDiskTrend | null | undefined): string {
  if (!disk || disk.freeGb === null) return 'free disk unknown';
  const free = `${disk.freeGb} GB`;
  if (disk.direction === 'unknown') return `free disk ${free}, no trend yet`;
  if (disk.direction === 'flat') return `free disk ${free}, holding steady`;
  const rate = `${Math.abs(disk.gbPerHour!).toFixed(1)} GB an hour`;
  if (disk.direction === 'rising') return `free disk ${free}, rising ${rate}`;
  return `free disk ${free}, falling ${rate}${disk.hoursToFloor === null ? '' : `, ${diskHoursWords(disk.hoursToFloor)} to the ${disk.floorGb} GB floor`}`;
}

/** The warning line, shown wherever the report is: null when there is nothing to warn about. */
export function hostDiskWarningLine(disk: HostDiskTrend | null | undefined): string | null {
  if (!disk || !disk.warning) return null;
  if (disk.warning === 'below-floor') return `Warning: free disk is ${disk.freeGb} GB, below the ${disk.floorGb} GB floor.`;
  return `Warning: free disk is ${disk.freeGb} GB, falling ${disk.gbPerHour!.toFixed(1)} GB an hour; it reaches the ${disk.floorGb} GB floor in ${diskHoursWords(disk.hoursToFloor!)}.`;
}

export const hostTopMemory = (rssMb: number): string => rssMb >= 1024 ? `${(rssMb / 1024).toFixed(rssMb >= 10240 ? 0 : 1)} GB` : `${rssMb} MB`;

/** The load, pressure, swap and free-disk line, shared by the CLI and the card. Unknown is said as unknown.
 *  A disk that is heading for its floor too soon moves to its own warning line instead of this one. */
export function describeHostTop(host: HostTopReport['host']): string {
  const load = host.load1 === null ? 'Load unknown' : `Load ${round1(host.load1)}${host.load5 === null ? '' : ` (${round1(host.load5)} over 5 minutes)`}${host.cores === null ? '' : ` on ${host.cores} cores`}`;
  const base = `${load} · memory pressure ${host.pressure ?? 'unknown'} · swap used ${host.swapUsedGb === null ? 'unknown' : `${host.swapUsedGb} GB`}`;
  return host.disk && !host.disk.warning ? `${base} · ${describeHostDisk(host.disk)}` : base;
}
