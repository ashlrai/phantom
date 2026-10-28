/** Metadata-only input contract for interval engineering-efficiency insights. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface HopEventBase {
  schemaVersion: 1;
  /** Stable producer-assigned id; retries must reuse it. */
  id: string;
  ts: string;
  /** Canonical owner/repository slug, case insensitive. */
  repo: string;
}

export type HopEvent = HopEventBase & (
  | { kind: 'hop.completed'; tokensIn: number | null; tokensOut: number | null; costUsd: number | null }
  | { kind: 'pr.merged'; prNumber: number }
);

export type HopSourceState = 'available' | 'missing' | 'unavailable';

export interface HopEventSource {
  state: HopSourceState;
  /** Untrusted decoded rows; malformed JSON is represented by null. */
  events: unknown[];
}

export interface HopEfficiencyMetrics {
  hops: number;
  mergedPrs: number;
  /** Known subtotals; check coverage before interpreting them as totals. */
  tokens: number | null;
  costUsd: number | null;
  hopsWithTokens: number;
  hopsWithCost: number;
  tokensPerMergedPr: number | null;
  mergedPrsPerDollar: number | null;
}

export interface HopRollup {
  schemaVersion: 1;
  since: string;
  until: string;
  sourceState: HopSourceState;
  /** Partial includes malformed/conflicting evidence, not just missing usage. */
  status: 'complete' | 'partial' | 'empty' | 'missing' | 'unavailable';
  diagnostics: { invalidEvents: number; duplicateEvents: number; conflictingEvents: number; excludedEvents: number };
  totals: HopEfficiencyMetrics;
  byRepo: Array<HopEfficiencyMetrics & { repo: string }>;
}

export function hopEventsPath(): string {
  return join(homedir(), '.ashlr', 'observability', 'hops.jsonl');
}

/** Fail closed on an oversized/nonregular source; never silently roll up a tail. */
export const MAX_HOP_EVENT_BYTES = 8 * 1024 * 1024;

export function collectHopEvents(): HopEventSource {
  let fd: number | undefined;
  try {
    fd = openSync(hopEventsPath(), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_HOP_EVENT_BYTES) return { state: 'unavailable', events: [] };
    // Read at most the cap plus one byte, even if a producer grows the file.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_HOP_EVENT_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size) return { state: 'unavailable', events: [] };
    const events = buffer.toString('utf8', 0, length).split('\n').filter((line) => line.trim()).map((line): unknown => {
      try { return JSON.parse(line) as unknown; } catch { return null; }
    });
    return { state: 'available', events };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { state: missing ? 'missing' : 'unavailable', events: [] };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* never fail the dashboard on a close error */ }
    }
  }
}

const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokenCount = (value: unknown): value is number | null =>
  value === null || (nonnegative(value) && Number.isSafeInteger(value));

/** Allowlist only accounting metadata; extra payload fields never reach JSON. */
export function parseHopEvent(raw: unknown): HopEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row['schemaVersion'] !== 1 || typeof row['id'] !== 'string' ||
      !row['id'].trim() || row['id'].length > 256 || typeof row['ts'] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row['ts']) ||
      !Number.isFinite(Date.parse(row['ts'])) || typeof row['repo'] !== 'string' ||
      !/^[\w.-]+\/[\w.-]+$/.test(row['repo']) || row['repo'].length > 256) return null;
  if (new Date(row['ts']).toISOString() !== row['ts']) return null;
  const base: HopEventBase = {
    schemaVersion: 1, id: row['id'], ts: new Date(row['ts']).toISOString(), repo: row['repo'].toLowerCase(),
  };
  if (row['kind'] === 'pr.merged' && Number.isSafeInteger(row['prNumber']) && Number(row['prNumber']) > 0) {
    return { ...base, kind: 'pr.merged', prNumber: Number(row['prNumber']) };
  }
  if (row['kind'] !== 'hop.completed') return null;
  const tokensIn = row['tokensIn'] ?? null;
  const tokensOut = row['tokensOut'] ?? null;
  const costUsd = row['costUsd'] ?? null;
  if (!tokenCount(tokensIn) || !tokenCount(tokensOut) ||
      !(costUsd === null || nonnegative(costUsd))) return null;
  return { ...base, kind: 'hop.completed', tokensIn, tokensOut, costUsd };
}
