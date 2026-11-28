/** Metadata-only input contract for interval engineering-efficiency insights. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STRICT_UTC_ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const STRICT_UTC_ISO_MS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const UUID_V5_URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

export function isObservabilityRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function asObservabilityRecord(value: unknown): Record<string, unknown> | null {
  return isObservabilityRecord(value) ? value : null;
}
export function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Parse a canonical UTC ISO-8601 timestamp (rejecting calendar rollovers). */
export function parseStrictUtcIsoMs(value: unknown, requireMillis = false): number | null {
  if (typeof value !== 'string') return null;
  if (!(requireMillis ? STRICT_UTC_ISO_MS_RE : STRICT_UTC_ISO_RE).test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const expected = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(ms).toISOString() === expected ? ms : null;
}

/** Deterministic RFC 4122 UUIDv5 derived in the standard URL namespace. */
export function uuidV5Url(name: string): string {
  const bytes = createHash('sha1').update(UUID_V5_URL_NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Run fetch with an AbortController deadline; aborts throw a credential-free AbortError. */
export async function fetchWithTimeout(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const abortErr = new Error('Request timed out');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a regular file up to maxBytes (including files growing after stat). */
export async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected regular file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('File exceeds maximum size');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

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

const tokenCount = (value: unknown): value is number | null =>
  value === null || isNonNegativeSafeInt(value);

/** Allowlist only accounting metadata; extra payload fields never reach JSON. */
export function parseHopEvent(raw: unknown): HopEvent | null {
  if (!isObservabilityRecord(raw)) return null;
  const tsMs = parseStrictUtcIsoMs(raw['ts'], true);
  if (raw['schemaVersion'] !== 1 || typeof raw['id'] !== 'string' ||
      !raw['id'].trim() || raw['id'].length > 256 || tsMs === null ||
      typeof raw['repo'] !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(raw['repo']) ||
      raw['repo'].length > 256) return null;
  const base: HopEventBase = {
    schemaVersion: 1, id: raw['id'], ts: new Date(tsMs).toISOString(), repo: raw['repo'].toLowerCase(),
  };
  if (raw['kind'] === 'pr.merged' && isPositiveSafeInt(raw['prNumber'])) {
    return { ...base, kind: 'pr.merged', prNumber: raw['prNumber'] };
  }
  if (raw['kind'] !== 'hop.completed') return null;
  const tokensIn = raw['tokensIn'] ?? null;
  const tokensOut = raw['tokensOut'] ?? null;
  const costUsd = raw['costUsd'] ?? null;
  if (!tokenCount(tokensIn) || !tokenCount(tokensOut) ||
      !(costUsd === null || isNonNegativeFinite(costUsd))) return null;
  return { ...base, kind: 'hop.completed', tokensIn, tokensOut, costUsd };
}
