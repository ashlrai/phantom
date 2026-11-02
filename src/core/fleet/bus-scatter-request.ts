/**
 * Bounded parallel request fan-out over the local bus: a planner scatters a
 * small batch of independent requests and collects each correlated reply under
 * one shared monotonic deadline instead of serially spending one timeout per
 * agent. Correlation stays untrusted, reply bodies are never executed, and
 * original request IDs pass through untouched for transport dedupe on retry.
 */
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import { type BusInboxOptions } from './bus-inbox.js';
import { requestBusRoundtrip, type RequestDependencies, type RequestOutcome, type RequestResult } from './bus-request-roundtrip.js';

export const BUS_SCATTER_MAX_REQUESTS = 16;
export const BUS_SCATTER_MAX_BYTES = 256 * 1024;
export const BUS_SCATTER_MIN_TIMEOUT_MS = 1;
export const BUS_SCATTER_MAX_TIMEOUT_MS = 60000;
export const BUS_SCATTER_DEFAULT_TIMEOUT_MS = BUS_SCATTER_MAX_TIMEOUT_MS;
export const BUS_SCATTER_MIN_CONCURRENCY = 1;
export const BUS_SCATTER_MAX_CONCURRENCY = 8;
export const BUS_SCATTER_DEFAULT_CONCURRENCY = 4;
/** Fixed poll interval shared by every request wait in the batch. */
export const BUS_SCATTER_INTERVAL_MS = 250;

export type ScatterRowOutcome = RequestOutcome | 'not-attempted';
export type ScatterStatus = 'preview' | 'all-replied' | 'partial' | 'invalid-input' | 'cancelled';

/** One row per input request, always in original input order. */
export interface BusScatterRow {
  id: string;
  from: string;
  to: string;
  priority: BusEnvelope['priority'];
  ttl: number;
  outcome: ScatterRowOutcome;
  /** Exact requestBusRoundtrip result for attempted rows; null otherwise. */
  result: RequestResult | null;
}

export interface BusScatterReport {
  schema: 'fleet.bus-scatter.v1';
  mode: 'preview' | 'apply';
  status: ScatterStatus;
  correlation: 'untrusted-routing-only';
  concurrency: number;
  timeoutMs: number;
  intervalMs: number;
  elapsedMs: number;
  counts: { total: number; attempted: number; replied: number; failed: number; notAttempted: number };
  requests: BusScatterRow[];
}

export interface ScatterDependencies extends RequestDependencies {
  /** Request boundary; defaults to requestBusRoundtrip. Injectable for tests. */
  request?: typeof requestBusRoundtrip;
}

export type BusScatterParse = { ok: true; requests: BusEnvelope[] } | { ok: false };

/**
 * Validate the whole batch before any transport write: exactly {"version":1,
 * "requests":[...]} with 1..16 envelopes, no unknown keys, no duplicate IDs.
 */
export function validateBusScatterBatch(input: unknown): BusScatterParse {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return { ok: false };
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return { ok: false };
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || keys.some(key => key !== 'version' && key !== 'requests')) return { ok: false };
  for (const key of ['version', 'requests'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return { ok: false };
  }
  const { version, requests } = input as { version: unknown; requests: unknown };
  if (version !== 1 || !Array.isArray(requests) || isProxy(requests) ||
      requests.length < 1 || requests.length > BUS_SCATTER_MAX_REQUESTS ||
      Object.keys(requests).length !== requests.length) return { ok: false };
  const envelopes: BusEnvelope[] = [], ids = new Set<string>();
  for (const row of requests) {
    const checked = validateBusEnvelope(row);
    if (!checked.ok || ids.has(checked.value.id)) return { ok: false };
    ids.add(checked.value.id);
    envelopes.push(checked.value);
  }
  return { ok: true, requests: envelopes };
}

/** Parse the --file payload: {"version":1,"requests":[<BusEnvelope>...]}. */
export function parseBusScatterFile(text: string): BusScatterParse {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BUS_SCATTER_MAX_BYTES) return { ok: false };
  try { return validateBusScatterBatch(JSON.parse(text)); } catch { return { ok: false }; }
}

function scatterReport(mode: 'preview' | 'apply', status: ScatterStatus, concurrency: number,
  timeoutMs: number, startedAt: number, rows: BusScatterRow[]): BusScatterReport {
  const attempted = rows.filter(row => row.result !== null).length;
  const replied = rows.filter(row => row.outcome === 'replied').length;
  return {
    schema: 'fleet.bus-scatter.v1', mode, status, correlation: 'untrusted-routing-only',
    concurrency, timeoutMs, intervalMs: BUS_SCATTER_INTERVAL_MS,
    elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
    counts: { total: rows.length, attempted, replied, failed: attempted - replied, notAttempted: rows.length - attempted },
    requests: rows,
  };
}

function checkedScatterRows(requests: BusEnvelope[], timeoutMs: number, concurrency: number):
  { ok: true; envelopes: BusEnvelope[]; rows: BusScatterRow[] } | { ok: false } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < BUS_SCATTER_MIN_TIMEOUT_MS || timeoutMs > BUS_SCATTER_MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(concurrency) || concurrency < BUS_SCATTER_MIN_CONCURRENCY || concurrency > BUS_SCATTER_MAX_CONCURRENCY ||
      !Array.isArray(requests) || requests.length < 1 || requests.length > BUS_SCATTER_MAX_REQUESTS) return { ok: false };
  const envelopes: BusEnvelope[] = [], rows: BusScatterRow[] = [], ids = new Set<string>();
  for (const row of requests) {
    const checked = validateBusEnvelope(row);
    if (!checked.ok || ids.has(checked.value.id)) return { ok: false };
    ids.add(checked.value.id);
    const { id, from, to, priority, ttl } = checked.value;
    envelopes.push(checked.value);
    rows.push({ id, from, to, priority, ttl, outcome: 'not-attempted', result: null });
  }
  return { ok: true, envelopes, rows };
}

/**
 * Run a validated batch with bounded concurrency under one shared monotonic
 * deadline: every attempted request shares `startedAt + timeoutMs`, so the batch
 * costs one timeout total, not one per agent. Queued work that reaches the
 * deadline is left 'not-attempted'; an abort stops launches and propagates into
 * every active wait. One row's failure never erases another row's reply.
 */
export async function scatterBusRequests(requests: BusEnvelope[], timeoutMs: number, concurrency: number,
  options: BusInboxOptions = {}, deps: ScatterDependencies = {}): Promise<BusScatterReport> {
  const start = deps.startedAt ?? performance.now(), deadline = start + timeoutMs;
  const checked = checkedScatterRows(requests, timeoutMs, concurrency);
  if (!checked.ok) return scatterReport('apply', 'invalid-input', concurrency, timeoutMs, start, []);
  const { envelopes, rows } = checked;
  const request = deps.request ?? requestBusRoundtrip, signal = deps.signal;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const index = next++;
      if (index >= envelopes.length || deadline - performance.now() < 1) return;
      let result: RequestResult;
      try {
        result = await request(envelopes[index], timeoutMs, BUS_SCATTER_INTERVAL_MS, options,
          { list: deps.list, append: deps.append, signal, startedAt: start });
      } catch {
        result = { schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only',
          receipt: { status: 'not-attempted' }, outcome: 'source-unavailable', reply: null,
          cursor: 0, elapsedMs: Math.max(0, Math.floor(performance.now() - start)) };
      }
      const row = rows[index]!;
      row.outcome = result.outcome;
      row.result = result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, envelopes.length) }, () => worker()));
  return scatterReport('apply',
    signal?.aborted ? 'cancelled' : rows.every(row => row.outcome === 'replied') ? 'all-replied' : 'partial',
    concurrency, timeoutMs, start, rows);
}

/** Preview validates and returns bounded routing metadata only; no posts. */
export function previewBusScatter(requests: BusEnvelope[], timeoutMs: number, concurrency: number,
  deps: Pick<ScatterDependencies, 'startedAt'> = {}): BusScatterReport {
  const checked = checkedScatterRows(requests, timeoutMs, concurrency);
  return scatterReport('preview', checked.ok ? 'preview' : 'invalid-input', concurrency, timeoutMs,
    deps.startedAt ?? performance.now(), checked.ok ? checked.rows : []);
}
