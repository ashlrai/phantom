/**
 * core/observability/fleet-hop.ts: queue.v1 `fleet_hop` emitter (RQ-QUEUE-1/2, RQ-BUS-5A).
 *
 * The Mac bridge calls this at each station exit. One hop is one job leaving
 * one station (planned, ready, claimed, publish, ci, merge_queue, merged, ...).
 *
 * GUARDRAILS:
 *   - METADATA ONLY: an allowlist of ids, station, pool, tier, timestamps and
 *     counters. Bodies, prompts, paths and keys are never copied. String values
 *     must match a short id-shaped pattern or they are dropped.
 *   - NEVER BLOCKS: no key, no endpoint, timeout or HTTP error means the event
 *     is appended to a local JSONL spool and the call resolves. Nothing throws.
 *     The CLI wrapper always exits 0, so the caller's exit code is unchanged.
 *   - KEY: read only from POSTHOG_AGENT_FLEET_TOKEN in the environment that
 *     `phantom exec --` provides. Never logged, returned or spooled.
 *   - DEDUP: $insert_id = sha256(job_id|pr|station|enter_ts), first 32 hex, so
 *     replays and retries collapse in PostHog and in spool replay.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const FLEET_HOP_EVENT = 'fleet_hop';
export const FLEET_HOP_SCHEMA = 'queue.v1';
export const FLEET_HOP_KEY_ENV = 'POSTHOG_AGENT_FLEET_TOKEN';
export const FLEET_HOP_HOST_ENV = 'POSTHOG_HOST';
const DEFAULT_HOST = 'https://us.i.posthog.com';
const FETCH_TIMEOUT_MS = 3_000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,119}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STRING_FIELDS = ['job_id', 'station', 'pool', 'tier', 'node', 'engine', 'job', 'agent', 'repo'] as const;
const NUMBER_FIELDS = ['tokens', 'usd'] as const;

export interface FleetHopInput {
  job_id?: unknown; pr?: unknown; station?: unknown; pool?: unknown; tier?: unknown;
  enter_ts?: unknown; exit_ts?: unknown; node?: unknown; engine?: unknown; tokens?: unknown;
  usd?: unknown; job?: unknown; agent?: unknown; repo?: unknown; test?: unknown;
}

export interface FleetHopEvent {
  event: typeof FLEET_HOP_EVENT;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, string | number | boolean | null>;
}

export interface FleetHopResult {
  sent: boolean;
  spooled: boolean;
  dropped: boolean;
  detail: string;
}

export interface FleetHopOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spoolPath?: string;
  now?: () => Date;
}

export function fleetHopSpoolPath(): string {
  return join(homedir(), '.ashlr', 'telemetry', 'fleet-hop-spool.jsonl');
}

function idOrNull(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

function tsOrNull(v: unknown): string | null {
  return typeof v === 'string' && TS_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

export function fleetHopInsertId(jobId: string | null, pr: number | null, station: string, enterTs: string): string {
  return createHash('sha256')
    .update(`${jobId ?? ''}|${pr ?? ''}|${station}|${enterTs}`)
    .digest('hex')
    .slice(0, 32);
}

/** Builds a sanitized queue.v1 hop, or null when station or enter_ts is missing or invalid. */
export function buildFleetHop(input: FleetHopInput, now: () => Date = () => new Date()): FleetHopEvent | null {
  const station = idOrNull(input.station);
  const enterTs = tsOrNull(input.enter_ts);
  if (!station || !enterTs) return null;
  const exitTs = tsOrNull(input.exit_ts) ?? now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prNum = numOrNull(input.pr);
  const pr = prNum !== null && Number.isInteger(prNum) && prNum > 0 ? prNum : null;

  const props: Record<string, string | number | boolean | null> = { schema: FLEET_HOP_SCHEMA };
  for (const f of STRING_FIELDS) props[f] = idOrNull(input[f]);
  props.station = station;
  props.pr = pr;
  props.enter_ts = enterTs;
  props.exit_ts = exitTs;
  for (const f of NUMBER_FIELDS) props[f] = numOrNull(input[f]);
  const dur = (Date.parse(exitTs) - Date.parse(enterTs)) / 1000;
  props.duration_s = dur >= 0 ? dur : null;
  props.test = input.test === true || input.test === 'true';
  props.source = 'agent_fleet';
  props.$process_person_profile = false;
  props.$insert_id = fleetHopInsertId(props.job_id as string | null, pr, station, enterTs);

  const agent = props.agent as string | null;
  return {
    event: FLEET_HOP_EVENT,
    distinct_id: agent ? `agent:${agent}` : `station:${station}`,
    timestamp: exitTs,
    properties: props,
  };
}

function spool(event: FleetHopEvent, path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function post(event: FleetHopEvent, key: string, host: string, fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${host.replace(/\/+$/, '')}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, ...event }),
      signal: controller.signal,
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network error';
  } finally {
    clearTimeout(timer);
  }
}

/** Sends one hop. Never throws; on any failure the hop is spooled. */
export async function emitFleetHop(input: FleetHopInput, opts: FleetHopOptions = {}): Promise<FleetHopResult> {
  const event = buildFleetHop(input, opts.now);
  if (!event) return { sent: false, spooled: false, dropped: true, detail: 'missing station or enter_ts' };
  return deliver(event, opts);
}

async function deliver(event: FleetHopEvent, opts: FleetHopOptions): Promise<FleetHopResult> {
  const env = opts.env ?? process.env;
  const path = opts.spoolPath ?? fleetHopSpoolPath();
  const key = env[FLEET_HOP_KEY_ENV];
  let detail = 'no key';
  if (key) {
    const host = env[FLEET_HOP_HOST_ENV] || DEFAULT_HOST;
    try {
      const err = await post(event, key, host, opts.fetchImpl ?? fetch);
      if (err === null) return { sent: true, spooled: false, dropped: false, detail: 'sent' };
      detail = err;
    } catch {
      detail = 'send failed';
    }
  }
  const spooled = spool(event, path);
  return { sent: false, spooled, dropped: false, detail };
}

/**
 * Replays the spool: dedups by $insert_id, sends what it can, and rewrites the
 * spool with only the events that still failed. Never throws.
 */
export async function replayFleetHopSpool(opts: FleetHopOptions = {}): Promise<{ sent: number; kept: number; duplicates: number }> {
  const path = opts.spoolPath ?? fleetHopSpoolPath();
  const out = { sent: 0, kept: 0, duplicates: 0 };
  let lines: string[];
  try {
    if (!existsSync(path)) return out;
    lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return out;
  }
  const seen = new Set<string>();
  const keep: FleetHopEvent[] = [];
  const env = opts.env ?? process.env;
  for (const line of lines) {
    let ev: FleetHopEvent;
    try {
      ev = JSON.parse(line) as FleetHopEvent;
    } catch {
      continue;
    }
    const id = String(ev?.properties?.$insert_id ?? '');
    if (!id || seen.has(id)) {
      out.duplicates += id ? 1 : 0;
      continue;
    }
    seen.add(id);
    const key = env[FLEET_HOP_KEY_ENV];
    const err = key ? await post(ev, key, env[FLEET_HOP_HOST_ENV] || DEFAULT_HOST, opts.fetchImpl ?? fetch) : 'no key';
    if (err === null) out.sent++;
    else keep.push(ev);
  }
  out.kept = keep.length;
  try {
    writeFileSync(path, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
  } catch {
    /* best effort */
  }
  return out;
}

/** CLI entry: JSON hop on stdin (or `--replay`). Always resolves to exit code 0. */
export async function runFleetHopCli(argv: string[], stdinText: string, opts: FleetHopOptions = {}): Promise<0> {
  try {
    if (argv.includes('--replay')) {
      await replayFleetHopSpool(opts);
      return 0;
    }
    const input = JSON.parse(stdinText) as FleetHopInput;
    if (input && typeof input === 'object') await emitFleetHop(input, opts);
  } catch {
    /* telemetry never fails the caller */
  }
  return 0;
}
