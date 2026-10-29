/**
 * core/observability/telemetry-sink.ts — M19 telemetry sink seam.
 *
 * GenAI span implementations:
 *   LocalFileSink  — default (no endpoint / no PAT). Appends spans as JSONL
 *                    to a daily file under ~/.ashlr/telemetry/. What `ashlr
 *                    pulse` already aggregates locally.
 *   OtlpHttpSink   — opt-in, only when cfg.telemetry.pulse AND a PAT are
 *                    both present. Builds an OTLP/HTTP-JSON trace and POSTs
 *                    it to the configured endpoint. Fire-and-forget, bounded
 *                    timeout, never throws/blocks.
 *   emitBusHopEvent — versioned PostHog hop events, local spool first and
 *                    explicit network opt-in with an environment-only key.
 *
 * GUARDRAILS:
 *   - PRIVACY: JSONL records and span attributes are METADATA ONLY (model,
 *     token counts, cost, ids, provider, tier, status, duration). NEVER
 *     prompt/response text, tool args, file contents, or secrets.
 *   - PAT/SECRET SAFETY: PAT lives ONLY in the Authorization header. It is
 *     NEVER logged, printed, returned, placed in span attrs or `detail`, or
 *     committed. Source: existing ASHLR_PULSE_TOKEN env var. Vault transport is unsupported.
 *   - All emits are best-effort: ok:false is logged to stderr only and NEVER
 *     blocks or propagates out of a run/swarm.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveProviderKey } from '../integrations/secrets.js';
import { scrubSecrets } from '../util/scrub.js';
import type { AshlrConfig, GenAiSpan, TelemetryEmitResult } from '../types.js';
import { buildGenAiTrace, buildQueueTrace } from './otlp.js';
import type { OtlpTrace } from './otlp.js';
import type { QueueEventV1 } from './queue-events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fetch timeout for OTLP POST — bounded, never blocks a run. Kept short
 * (this is a fire-and-forget metadata POST); a dead/slow-but-reachable
 * endpoint must not add meaningful wall-clock latency to run/swarm completion.
 */
const OTLP_FETCH_TIMEOUT_MS = 3_000;
// ---------------------------------------------------------------------------
// Public: localTelemetryDir
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the local telemetry directory:
 * ~/.ashlr/telemetry
 *
 * Re-resolves homedir() at call time so a relocated HOME in tests is honored.
 */
export function localTelemetryDir(): string {
  return join(homedir(), '.ashlr', 'telemetry');
}

// ---------------------------------------------------------------------------
// Public: patAvailable
// ---------------------------------------------------------------------------

/**
 * Current OTLP readiness requires a valid existing environment PAT.
 * Vault-name presence does not qualify a parent-process request transport.
 * The second parameter is retained for public API compatibility; no probe runs.
 */
export function patAvailable(cfg: AshlrConfig, _allowPhantomProbe = true): boolean {
  return resolveProviderKey('ASHLR_PULSE_TOKEN', cfg) !== undefined;
}

// ---------------------------------------------------------------------------
// Public: TelemetrySink interface
// ---------------------------------------------------------------------------

export interface TelemetrySink {
  emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult>;
}

export interface QueueTelemetrySink {
  /** Events must pass parseQueueEventV1 at the producer boundary. */
  emit(events: readonly QueueEventV1[]): Promise<TelemetryEmitResult>;
}

/** Reuse the existing analytics selection, credentials and bounded transport. */
export function getQueueSink(cfg: AshlrConfig, allowPhantomProbe = true): QueueTelemetrySink {
  const sink = selectSink(cfg, allowPhantomProbe);
  return { emit: events => sink.emitQueue(events) };
}

// ---------------------------------------------------------------------------
// Public: getSink
// ---------------------------------------------------------------------------

/**
 * Returns the appropriate TelemetrySink for the given config:
 *   - OtlpHttpSink when cfg.telemetry.pulse is set AND a PAT is available.
 *   - LocalFileSink (default, 100% local) otherwise.
 *
 * The existing probe-off emit path selects OTLP for a configured endpoint;
 * absent credentials produce an unavailable result. Other callers select local
 * storage unless the existing environment credential is currently usable.
 */
export function getSink(cfg: AshlrConfig, allowPhantomProbe = true): TelemetrySink {
  return selectSink(cfg, allowPhantomProbe);
}

function selectSink(cfg: AshlrConfig, allowPhantomProbe: boolean): LocalFileSink | OtlpHttpSink {
  if (cfg.telemetry?.pulse) {
    // On the emit path (probe off): select OTLP whenever an endpoint is set and
    // let OtlpHttpSink resolve the PAT async; if none, emit() is a logged no-op.
    if (!allowPhantomProbe) return new OtlpHttpSink(cfg);
    // CLI path: use current environment availability; no vault subprocess.
    if (patAvailable(cfg, true)) return new OtlpHttpSink(cfg);
  }
  return new LocalFileSink();
}

// ---------------------------------------------------------------------------
// LocalFileSink — default, 100% local
// ---------------------------------------------------------------------------

/**
 * Appends spans as JSONL to a daily file under ~/.ashlr/telemetry/.
 * File name: telemetry-YYYY-MM-DD.jsonl
 * Each line is a single JSON object containing one span (metadata only).
 * What `ashlr pulse` already aggregates locally.
 */
class LocalFileSink implements TelemetrySink {
  async emitQueue(events: readonly QueueEventV1[]): Promise<TelemetryEmitResult> {
    if (events.length === 0) return { sink: 'local', ok: true, detail: 'no events' };
    try {
      const dir = localTelemetryDir();
      mkdirSync(dir, { recursive: true });
      // Keep queue records out of usage-span files consumed by Pulse rollups.
      const file = join(dir, `queue-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const lines = events.map(({ job_id, pr, station, pool, tier, enter_ts, exit_ts }) =>
        JSON.stringify({ event: 'queue.v1', properties: { job_id, pr, station, pool, tier, enter_ts, exit_ts } }));
      appendFileSync(file, lines.join('\n') + '\n', 'utf8');
      return { sink: 'local', ok: true, detail: `appended ${events.length} queue event(s)` };
    } catch {
      return { sink: 'local', ok: false, detail: 'queue telemetry write failed' };
    }
  }

  async emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult> {
    if (spans.length === 0) {
      return { sink: 'local', ok: true, detail: 'no spans' };
    }
    try {
      const dir = localTelemetryDir();
      mkdirSync(dir, { recursive: true });

      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filePath = join(dir, `telemetry-${date}.jsonl`);

      const lines = spans.map((span) => JSON.stringify(span)).join('\n') + '\n';
      appendFileSync(filePath, lines, 'utf8');

      return { sink: 'local', ok: true, detail: `appended ${spans.length} span(s) to ${filePath}` };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashlr telemetry] LocalFileSink error: ${detail}\n`);
      return { sink: 'local', ok: false, detail };
    }
  }
}

// ---------------------------------------------------------------------------
// OtlpHttpSink — opt-in, endpoint + PAT required
// ---------------------------------------------------------------------------

/**
 * Builds an OTLP/HTTP-JSON trace payload from the spans and POSTs it to
 * cfg.telemetry.pulse. Uses a bounded fetch timeout (fire-and-forget).
 * PAT sourced from the existing ASHLR_PULSE_TOKEN environment route — placed
 * ONLY in the Authorization header, never logged or returned.
 */
class OtlpHttpSink implements TelemetrySink {
  constructor(private readonly cfg: AshlrConfig) {}

  async emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult> {
    return this.postTrace(spans.length, () => buildGenAiTrace(spans));
  }

  async emitQueue(events: readonly QueueEventV1[]): Promise<TelemetryEmitResult> {
    return this.postTrace(events.length, () => buildQueueTrace(events));
  }

  private async postTrace(count: number, build: () => OtlpTrace): Promise<TelemetryEmitResult> {
    const endpoint = this.cfg.telemetry?.pulse;
    if (!endpoint) {
      return { sink: 'otlp', ok: false, detail: 'no endpoint configured' };
    }

    // Resolve the existing environment credential without subprocesses.
    const pat = resolveProviderKey('ASHLR_PULSE_TOKEN', this.cfg);
    if (!pat) {
      return { sink: 'otlp', ok: false, detail: 'PAT unavailable' };
    }

    if (count === 0) {
      return { sink: 'otlp', ok: true, detail: 'no spans' };
    }

    try {
      const body = JSON.stringify(build());

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OTLP_FETCH_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            // PAT only in the Authorization header — never logged, never in detail.
            Authorization: `Bearer ${pat}`,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        return { sink: 'otlp', ok: true, detail: `HTTP ${res.status}` };
      }

      const detail = `HTTP ${res.status}`;
      process.stderr.write(`[ashlr telemetry] OtlpHttpSink: ${detail}\n`);
      return { sink: 'otlp', ok: false, detail };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      // Transport exceptions can include request headers. Never echo them.
      const detail = isAbort ? 'request timed out' : 'telemetry request failed';
      process.stderr.write(`[ashlr telemetry] OtlpHttpSink error: ${detail}\n`);
      return { sink: 'otlp', ok: false, detail };
    }
  }
}

// ---------------------------------------------------------------------------
// Bus hop events — RQ-BUS-5A (independent of the M19 span/OTLP contract)
// ---------------------------------------------------------------------------

/** Metadata only: identifiers, never goals, prompts, responses or tool args. */
export interface BusHopInput {
  node: string;
  engine: string;
  /** Unknown counts/cost MUST remain null, rather than becoming measured zero. */
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  job: string;
  /** Repository-scoped PR number, or null before a PR exists. */
  pr: number | null;
}

/** Credential-free PostHog capture envelope, also the on-disk JSONL schema. */
export interface BusHopEvent {
  event: 'phantom_bus_hop';
  timestamp: string;
  properties: {
    schema_version: 1;
    $insert_id: string;
    $process_person_profile: false;
    distinct_id: string;
    node: string;
    engine: string;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
    job: string;
    pr: number | null;
  };
}

export interface BusHopOptions {
  /** Explicit opt-in: HTTPS PostHog origin (US, EU or self-hosted), no path/query. */
  posthogHost?: string;
}

export interface BusHopEmitResult {
  ok: boolean;
  spooled: boolean;
  delivered: boolean;
  /** Fixed, value-free diagnostics; never input, credentials or thrown messages. */
  detail: string;
}

/**
 * Canonical schema builder. Unknown runtime fields are deliberately discarded.
 * Throws a value-free error for invalid metadata; emitBusHopEvent catches it.
 */
export function buildBusHopEvent(input: BusHopInput): BusHopEvent {
  let snapshot: BusHopInput;
  try {
    const { node, engine, job, tokensIn, tokensOut, costUsd, pr } = input;
    snapshot = { node, engine, job, tokensIn, tokensOut, costUsd, pr };
  } catch {
    throw new Error('invalid bus hop metadata');
  }
  // Snapshot once: getters must not substitute unvalidated values on a reread.
  const { node, engine, job, tokensIn, tokensOut, costUsd, pr } = snapshot;
  const identifier = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value) &&
    scrubSecrets(value) === value && !/(?:phc_|phx_|phm_)[A-Za-z0-9_-]+/.test(value);
  const count = (value: unknown): boolean => value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  if (!identifier(node) || !identifier(engine) || !identifier(job) ||
      !count(tokensIn) || !count(tokensOut) ||
      !(costUsd === null || (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0)) ||
      !(pr === null || (typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0))) {
    throw new Error('invalid bus hop metadata');
  }
  const event: BusHopEvent = {
    event: 'phantom_bus_hop',
    timestamp: new Date().toISOString(),
    properties: {
      schema_version: 1,
      $insert_id: randomUUID(),
      $process_person_profile: false,
      distinct_id: node,
      node,
      engine,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      job,
      pr,
    },
  };
  // Even opaque environment credentials must not be copied into metadata.
  const key = process.env['POSTHOG_API_KEY'];
  if (key && JSON.stringify(event).includes(key)) throw new Error('invalid bus hop metadata');
  return event;
}

/**
 * Spool first to ~/.ashlr/telemetry/bus-hop-YYYY-MM-DD.jsonl (0700/0600).
 * A spool failure prevents delivery. The spool is retained even after success;
 * this is an audit trail, not an automatically replayed delivery queue.
 *
 * Network delivery requires posthogHost AND POSTHOG_API_KEY in this process's
 * environment, supplied by the operator via Phantom Secrets `phantom exec --`.
 * No key argument, config, file lookup, vault extraction or credential caching.
 * Unresolved phm_ placeholders stay local: this client cannot extract secrets
 * from the Secrets child proxy. The key exists only in the transient request
 * body required by PostHog, never the spool, URL, result or logs.
 * https://posthog.com/docs/getting-started/install#sending-events
 */
export async function emitBusHopEvent(input: BusHopInput, options: BusHopOptions = {}): Promise<BusHopEmitResult> {
  let event: BusHopEvent;
  try {
    event = buildBusHopEvent(input);
  } catch {
    return { ok: false, spooled: false, delivered: false, detail: 'invalid bus hop metadata' };
  }
  try {
    const dir = localTelemetryDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `bus-hop-${event.timestamp.slice(0, 10)}.jsonl`),
      JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    return { ok: false, spooled: false, delivered: false, detail: 'bus hop spool unavailable' };
  }

  const local = { ok: true, spooled: true, delivered: false };
  let posthogHost: string | undefined;
  try {
    posthogHost = options.posthogHost;
    if (posthogHost !== undefined && typeof posthogHost !== 'string') throw new Error('invalid host');
  } catch {
    return { ok: false, spooled: true, delivered: false, detail: 'invalid PostHog host' };
  }
  if (!posthogHost) return { ...local, detail: 'spooled locally' };
  const key = process.env['POSTHOG_API_KEY'];
  if (!key || !key.trim() || /^phm_[A-Za-z0-9_-]+$/.test(key.trim())) {
    return { ...local, detail: 'spooled locally; PostHog credential unavailable' };
  }

  let endpoint: string;
  try {
    const host = new URL(posthogHost);
    if (host.protocol !== 'https:' || host.username || host.password ||
        host.pathname !== '/' || host.search || host.hash || posthogHost.includes(key)) {
      throw new Error('invalid host');
    }
    endpoint = new URL('/i/v0/e/', host).href;
  } catch {
    return { ok: false, spooled: true, delivered: false, detail: 'invalid PostHog host' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTLP_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, token: key }),
      redirect: 'error', // Never forward the credential to a redirect target.
      signal: controller.signal,
    });
    // No response content is needed; don't retain a streaming response body.
    void response.body?.cancel().catch(() => {});
    return response.ok
      ? { ok: true, spooled: true, delivered: true, detail: 'delivered to PostHog' }
      : { ok: false, spooled: true, delivered: false, detail: 'PostHog request rejected' };
  } catch {
    // Fetch errors can contain credentials/URLs. Never serialize or log them.
    return { ok: false, spooled: true, delivered: false,
      detail: controller.signal.aborted ? 'PostHog request timed out' : 'PostHog request failed' };
  } finally {
    clearTimeout(timer);
  }
}
