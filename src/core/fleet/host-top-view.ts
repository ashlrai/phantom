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

export const hostTopMemory = (rssMb: number): string => rssMb >= 1024 ? `${(rssMb / 1024).toFixed(rssMb >= 10240 ? 0 : 1)} GB` : `${rssMb} MB`;

/** The load, pressure and swap line, shared by the CLI and the card. Unknown is said as unknown. */
export function describeHostTop(host: HostTopReport['host']): string {
  const load = host.load1 === null ? 'Load unknown' : `Load ${round1(host.load1)}${host.load5 === null ? '' : ` (${round1(host.load5)} over 5 minutes)`}${host.cores === null ? '' : ` on ${host.cores} cores`}`;
  return `${load} · memory pressure ${host.pressure ?? 'unknown'} · swap used ${host.swapUsedGb === null ? 'unknown' : `${host.swapUsedGb} GB`}`;
}
