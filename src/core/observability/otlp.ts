import { completeReportedTokens, validateTokenEvidence } from '../run/token-evidence.js';
/**
 * core/observability/otlp.ts — M19 OTLP/HTTP-JSON trace builder.
 *
 * Pure, dependency-free helpers that turn a completed run/swarm into:
 *   - GenAiSpan[]  (spansFromRun / spansFromSwarm) — METADATA ONLY
 *   - an OTLP/HTTP-JSON trace payload (buildGenAiTrace) following the
 *     resourceSpans -> scopeSpans -> spans nesting, with GenAI
 *     semantic-convention attributes.
 *
 * PRIVACY INVARIANT (enforced here, asserted by m19.otlp.test.ts):
 *   Span attributes carry ONLY metadata — model id, token counts, cost, ids,
 *   provider, tier, status, duration. NEVER prompt/response text, sub-goal
 *   text, tool args, file contents, project paths, or secrets. The span
 *   `name` is the task id (a stable metadata identifier), never the goal.
 *
 * This module is imported statically by telemetry-sink.ts (buildGenAiTrace)
 * and dynamically by orchestrator.ts / swarm/runner.ts (spansFromRun /
 * spansFromSwarm). It must stay free of side effects and runtime deps.
 */

import { randomBytes } from 'node:crypto';
import type { GenAiSpan, RunState, SwarmRun } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Instrumentation scope advertised in scopeSpans[].scope. */
const SCOPE_NAME = 'ashlr-hub';
const SCOPE_VERSION = '0.1.0';

/** Nanoseconds per millisecond (OTLP timestamps are unix-nanoseconds). */
const NS_PER_MS = 1_000_000n;

// ---------------------------------------------------------------------------
// OTLP value wrappers (typed by JSON value kind)
// ---------------------------------------------------------------------------

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

interface OtlpSpan {
  /** 32 lowercase hex chars (16 random bytes). Required by the OTLP data model. */
  traceId: string;
  /** 16 lowercase hex chars (8 random bytes). Required by the OTLP data model. */
  spanId: string;
  /** OTLP span kind. 1=INTERNAL — GenAI calls are internal work units. */
  kind: number;
  name: string;
  /** Decimal string of unix-nanoseconds. */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** OTLP status object. code 0=unset, 1=ok(unused), 2=error. */
  status: { code: number };
  attributes: OtlpAttribute[];
}

interface OtlpScopeSpans {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: OtlpScopeSpans[];
}

export interface OtlpTrace {
  resourceSpans: OtlpResourceSpans[];
}

// ---------------------------------------------------------------------------
// Internal attribute helpers
// ---------------------------------------------------------------------------

function strAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** Integer attribute — OTLP intValue is a decimal string per the JSON mapping. */
function intAttr(key: string, value: number): OtlpAttribute {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  return { key, value: { intValue: String(n) } };
}

function doubleAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { doubleValue: Number.isFinite(value) ? value : 0 } };
}

/**
 * Convert an ISO timestamp to a unix-nanosecond decimal string. Invalid or
 * missing timestamps fall back to 0 so the builder never throws.
 */
function isoToUnixNano(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '0';
  return (BigInt(ms) * NS_PER_MS).toString();
}

/** Map a terminal status string to an OTLP status code (2=error else unset). */
function statusCode(status: string): number {
  return status === 'failed' || status === 'aborted' ? 2 : 0;
}

/** OTLP SpanKind.INTERNAL — these are internal work units, not RPC client spans. */
const SPAN_KIND_INTERNAL = 1;

/** Random 16-byte trace id as 32 lowercase hex chars (OTLP-required identifier). */
function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Random 8-byte span id as 16 lowercase hex chars (OTLP-required identifier). */
function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Public: buildGenAiTrace
// ---------------------------------------------------------------------------

/**
 * Build a valid OTLP/HTTP-JSON trace from GenAiSpan metadata.
 *
 * Shape: { resourceSpans: [ { resource, scopeSpans: [ { scope, spans } ] } ] }.
 * Every span carries GenAI semantic-convention attributes plus ashlr.* ids.
 * Handles an empty `spans` array gracefully (one resourceSpans entry with an
 * empty spans list). METADATA ONLY — never content.
 */
export function buildGenAiTrace(spans: GenAiSpan[]): OtlpTrace {
  // One trace id per emitted batch; per-span ids below. Random bytes carry no
  // content — still METADATA ONLY. Required by the OTLP data model and by
  // backends (Tempo/Jaeger/Honeycomb) that drop zero/empty-id spans.
  const traceId = newTraceId();

  const otlpSpans: OtlpSpan[] = spans.map((s) => {
    const start = isoToUnixNano(s.startTs);
    let end = isoToUnixNano(s.endTs);
    // Guarantee end >= start even if timestamps are equal/inverted.
    if (BigInt(end) < BigInt(start)) end = start;

    return {
      traceId,
      spanId: newSpanId(),
      kind: SPAN_KIND_INTERNAL,
      // name is the task id (metadata identifier) — never goal/result text.
      name: s.name,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      status: { code: statusCode(s.status) },
      attributes: [
        strAttr('gen_ai.system', s.provider),
        strAttr('gen_ai.request.model', s.model),
        ...(completeReportedTokens(s) ? [intAttr('gen_ai.usage.input_tokens', s.tokensIn), intAttr('gen_ai.usage.output_tokens', s.tokensOut)] : []),
        strAttr('phantom.token_provenance', completeReportedTokens(s) ? 'reported' : validateTokenEvidence(s.tokenEvidence, s.tokensIn, s.tokensOut) ? 'partial' : 'unknown'),
        intAttr('phantom.accounted.input_tokens', s.tokensIn),
        intAttr('phantom.accounted.output_tokens', s.tokensOut),
        ...(['reported', 'estimated', 'reserved', 'unknown'] as const).flatMap(basis => {
          const evidence = validateTokenEvidence(s.tokenEvidence, s.tokensIn, s.tokensOut);
          return evidence ? [intAttr(`phantom.${basis}.input_tokens`, evidence.input[basis]), intAttr(`phantom.${basis}.output_tokens`, evidence.output[basis])] : [];
        }),
        doubleAttr('gen_ai.usage.cost_usd', s.estCostUsd),
        strAttr('ashlr.run.id', s.runId),
        strAttr('ashlr.provider', s.provider),
        strAttr('ashlr.tier', s.tier),
        strAttr('ashlr.status', s.status),
        ...(s.memory ? [
          strAttr('phantom.memory.scope', s.memory.scope),
          ...(s.memory.peakRssBytes === null ? [] : [intAttr('phantom.memory.peak_rss_bytes', s.memory.peakRssBytes)]),
          intAttr('phantom.memory.sample_count', s.memory.sampleCount),
          intAttr('phantom.memguard.pause_events', s.memory.pauseEvents),
        ] : []),
      ],
    };
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr('service.name', SCOPE_NAME),
            strAttr('telemetry.sdk.name', SCOPE_NAME),
            strAttr('telemetry.sdk.language', 'nodejs'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans: otlpSpans,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Provider/model/tier derivation (metadata only)
// ---------------------------------------------------------------------------

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'bedrock', 'azure']);

/** Cloud vs local tier, inferred from the provider id (metadata only). */
function tierForProvider(provider: string): string {
  return CLOUD_PROVIDERS.has(provider.toLowerCase()) ? 'cloud' : 'local';
}

/**
 * A coarse model label derived from the provider — we never expose the actual
 * routed model name when it isn't tracked per-task, only a metadata stand-in.
 * The provider itself is metadata and safe to surface.
 */
function modelForProvider(provider: string): string {
  return provider || 'unknown';
}

// ---------------------------------------------------------------------------
// Public: spansFromRun
// ---------------------------------------------------------------------------

/**
 * Derive one GenAiSpan per RunTask that has usage. Pure — does not mutate the
 * run. Span name is the task id (metadata), NEVER the sub-goal text. No
 * result/goal text is read into the span. Timestamps fall back to the run's
 * createdAt/updatedAt window (per-task timestamps are not tracked).
 */
export function spansFromRun(run: RunState): GenAiSpan[] {
  const provider = run.provider || 'unknown';
  const model = modelForProvider(provider);
  const tier = tierForProvider(provider);
  const startTs = run.createdAt;
  const endTs = run.updatedAt;

  const spans: GenAiSpan[] = [];
  for (const task of run.tasks) {
    if (!task.usage) continue;
    spans.push({
      name: task.id, // metadata id, NOT task.goal
      runId: run.id,
      model,
      provider,
      tier,
      ...(validateTokenEvidence(task.usage.tokenEvidence, task.usage.tokensIn, task.usage.tokensOut) ? { tokenEvidence: task.usage.tokenEvidence } : {}),
      tokensIn: task.usage.tokensIn,
      tokensOut: task.usage.tokensOut,
      estCostUsd: task.usage.estCostUsd,
      status: task.status,
      startTs,
      endTs,
    });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Public: spansFromSwarm
// ---------------------------------------------------------------------------

/**
 * Derive one GenAiSpan per SwarmTaskRun that has usage. Pure — does not mutate
 * the swarm. Span name is the task id (metadata), NEVER goal/result/project
 * text. SwarmRun has no per-run provider, so provider/model/tier use neutral
 * metadata defaults. Timestamps fall back to the swarm's createdAt/updatedAt.
 */
export function spansFromSwarm(swarm: SwarmRun): GenAiSpan[] {
  const provider = 'ashlr-swarm';
  const model = 'swarm';
  const tier = 'local';
  const startTs = swarm.createdAt;
  const endTs = swarm.updatedAt;

  const spans: GenAiSpan[] = [];
  for (const task of swarm.tasks) {
    if (!task.usage) continue;
    spans.push({
      name: task.id, // metadata id, NOT goal/result/project
      runId: swarm.id,
      model,
      provider,
      tier,
      ...(validateTokenEvidence(task.usage.tokenEvidence, task.usage.tokensIn, task.usage.tokensOut) ? { tokenEvidence: task.usage.tokenEvidence } : {}),
      tokensIn: task.usage.tokensIn,
      tokensOut: task.usage.tokensOut,
      estCostUsd: task.usage.estCostUsd,
      status: task.status,
      startTs,
      endTs,
    });
  }
  return spans;
}

/** Metadata retained from untrusted native-client OTLP spans. */
export interface ReceivedOtelSpan {
  source: 'claude-code' | 'xai';
  event: 'api_request' | 'api_refusal' | 'tool_decision' | 'safety_event';
  /**
   * Derived refusal signal. Claude Code 2.1.312 stopped emitting
   * `claude_code.safety_event`, so refusals are read off each vendor's result
   * stream instead: a `claude_code.api_refusal` event, a `refusal` or
   * `content_filter` stop/finish reason, a rejected or cancelled tool
   * permission decision, or a legacy `safety_event` record. Refusal metrics
   * count this flag, never the event name alone.
   */
  refusal?: boolean;
  /** Corrected `effort` attribute: the effort level in force on the request. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Corrected `mcp_server.name` attribute: the real name of a fixed-URL remote
   * MCP server, or the 'custom'/'third-party' redaction placeholders.
   */
  mcpServerName?: string;
  /** Companion `mcp_tool.name` attribute, same redaction as `mcp_server.name`. */
  mcpToolName?: string;
  /**
   * `server_fallback_hop` on an api_refusal: true when the API's server-side
   * model fallback already retried this refusal on a different model (the user
   * never saw it), false when the request ended in the refusal.
   */
  serverFallbackHop?: boolean;
  usage: Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_tokens' |
    'cache_creation_tokens' | 'cache_creation_5m' | 'cache_creation_1h', number>>;
  costUsd?: number;
}

/**
 * Claude Code event names retained from the native stream — matched against a
 * `claude_code.<event>` span name or the `event.name` attribute. CC 2.1.312 no
 * longer emits `safety_event`; refusals arrive on the result stream as
 * `api_refusal` events, refusal stop/finish reasons and rejected
 * `tool_decision`/`tool.blocked_on_user` records instead.
 */
const CLAUDE_EVENTS = new Set([
  'api_request',
  'llm_request',
  'api_refusal',
  'tool_decision',
  'tool.blocked_on_user',
  'safety_event',
]);

/** Values allowed on the corrected `effort` attribute (CC >= 2.1.274). */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Stop/finish reasons that mark a refusal in a vendor result stream. */
const REFUSAL_REASONS = new Set(['refusal', 'content_filter']);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Strict numeric decoding: missing, negative and unsafe values stay unknown. */
function receivedNumber(value: unknown, integer: boolean): number | undefined {
  if (typeof value === 'string' && !(integer ? /^\d+$/ : /^\d+(?:\.\d+)?$/).test(value)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isSafeInteger(n)) ? n : undefined;
}

/** Bounded metadata label: non-empty and length-capped, else undefined. */
function receivedLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
    ? value.trim() : undefined;
}

/** Strict boolean decoding from OTLP boolValue or 'true'/'false' strings. */
function receivedBool(value: unknown): boolean | undefined {
  return value === true || value === 'true' ? true
    : value === false || value === 'false' ? false : undefined;
}

/**
 * True when a result-stream finish reason marks a refusal: `stop_reason`,
 * `finish_reason`, or a `gen_ai.response.finish_reasons` string list carrying
 * 'refusal' or 'content_filter' (OpenAI-compatible vendors such as xAI).
 */
function refusalFinishReason(attrs: Map<string, unknown>): boolean {
  const reasons: unknown[] = [attrs.get('stop_reason'), attrs.get('finish_reason')];
  const listed = attrs.get('gen_ai.response.finish_reasons');
  if (typeof listed === 'string') reasons.push(listed);
  else if (Array.isArray(listed)) reasons.push(...listed);
  return reasons.some(reason => typeof reason === 'string' &&
    reason.split(',').some(part => REFUSAL_REASONS.has(part.trim())));
}

/**
 * Decode OTLP/HTTP JSON without forwarding names, resources, ids, arbitrary
 * attributes or event bodies. Unknown spans are ignored; malformed envelopes
 * are refused. Cache lifetimes remain separate and are never added twice.
 *
 * Refusals come from the vendor result stream, not a dedicated event name:
 * `claude_code.api_refusal`, refusal stop/finish reasons and rejected tool
 * decisions all surface through `ReceivedOtelSpan.refusal`, as do legacy
 * `claude_code.safety_event` records for pre-2.1.312 streams.
 */
export function parseNativeOtelTrace(payload: unknown): ReceivedOtelSpan[] {
  const resources = record(payload).resourceSpans;
  if (!Array.isArray(resources)) throw new Error('Invalid OTLP trace envelope');
  const result: ReceivedOtelSpan[] = [];
  for (const resource of resources) {
    for (const scope of list(record(resource).scopeSpans)) {
      for (const raw of list(record(scope).spans)) {
        const span = record(raw);
        const attrs = new Map<string, unknown>();
        for (const attr of list(span.attributes)) {
          const a = record(attr);
          const v = record(a.value);
          if (typeof a.key !== 'string') continue;
          const scalar = v.intValue ?? v.doubleValue ?? v.stringValue ?? v.boolValue;
          if (scalar !== undefined) {
            attrs.set(a.key, scalar);
            continue;
          }
          const strings = list(record(v.arrayValue).values)
            .map(item => record(item).stringValue)
            .filter((s): s is string => typeof s === 'string');
          if (strings.length > 0) attrs.set(a.key, strings);
        }
        const name = typeof span.name === 'string' ? span.name : '';
        const spanEvent = name.startsWith('claude_code.') ? name.slice('claude_code.'.length) : '';
        const namedEvent = attrs.get('event.name');
        const claudeEvent = typeof namedEvent === 'string' && CLAUDE_EVENTS.has(namedEvent) ? namedEvent
          : CLAUDE_EVENTS.has(spanEvent) ? spanEvent : '';
        const xai = !claudeEvent &&
          (attrs.get('gen_ai.system') === 'xai' || attrs.get('gen_ai.provider.name') === 'xai');
        if (!claudeEvent && !xai) continue;
        const decision = attrs.get('decision');
        const refusal = claudeEvent === 'safety_event' || claudeEvent === 'api_refusal' ||
          decision === 'reject' || decision === 'cancelled' || refusalFinishReason(attrs);
        const received: ReceivedOtelSpan = {
          source: claudeEvent ? 'claude-code' : 'xai',
          event: claudeEvent === 'safety_event' ? 'safety_event'
            : claudeEvent === 'api_refusal' ? 'api_refusal'
            : claudeEvent === 'tool_decision' || claudeEvent === 'tool.blocked_on_user' ? 'tool_decision'
            : 'api_request',
          usage: {},
        };
        if (refusal) received.refusal = true;
        const effort = attrs.get('effort');
        if (typeof effort === 'string' && EFFORT_LEVELS.has(effort)) {
          received.effort = effort as NonNullable<ReceivedOtelSpan['effort']>;
        }
        const mcpServer = receivedLabel(attrs.get('mcp_server.name'));
        if (mcpServer !== undefined) received.mcpServerName = mcpServer;
        const mcpTool = receivedLabel(attrs.get('mcp_tool.name'));
        if (mcpTool !== undefined) received.mcpToolName = mcpTool;
        const hop = receivedBool(attrs.get('server_fallback_hop'));
        if (hop !== undefined) received.serverFallbackHop = hop;
        if (received.event === 'api_request') {
          for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens',
            'cache_creation_tokens', 'cache_creation_5m', 'cache_creation_1h'] as const) {
            const n = receivedNumber(attrs.get(key) ?? attrs.get(`gen_ai.usage.${key}`), true);
            if (n !== undefined) received.usage[key] = n;
          }
          const ticks = xai ? receivedNumber(attrs.get('cost_in_usd_ticks'), true) : undefined;
          const cost = ticks !== undefined ? ticks / 10_000_000_000 :
            receivedNumber(attrs.get('cost_usd') ?? attrs.get('gen_ai.usage.cost_usd'), false);
          if (cost !== undefined) received.costUsd = cost;
        }
        result.push(received);
      }
    }
  }
  return result;
}
