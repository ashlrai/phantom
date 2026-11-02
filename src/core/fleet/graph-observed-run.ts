/**
 * Observed argv-graph runs: executes an explicit local manifest via
 * graphArgvRun, then offers exactly one terminal node-outcome summary on the
 * shared bus inbox for another agent to consume.
 *
 * The envelope carries only id/status/exitCode rows — never argv, manifest
 * paths, environment, output text, or claim tokens — and bodies are untrusted
 * data that is never executed. From/to are routing labels: they authenticate
 * neither the sender nor whether any node actually succeeded.
 *
 * Reusing a run-id does NOT make execution idempotent: the deterministic
 * envelope id only deduplicates transport, so a repeated command runs the
 * graph again while the inbox reports a duplicate delivery.
 */
import { isAbsolute } from 'node:path';
import { graphArgvRun } from './graph-argv-run.js';
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from './bus-inbox.js';
import { MAX_BUS_ADDRESS_LENGTH, validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';

export const GRAPH_OBSERVE_SCHEMA = 'fleet.graph-observe.v1';
/** Terminal summaries stay claimable for fifteen minutes, then expire. */
export const GRAPH_OBSERVE_TTL_MS = 900_000;
const MAX_NODE_ROWS = 32;
const MAX_RUN_ID_LENGTH = 64;
const TERMINAL_STATUSES = ['complete', 'failed'];
/** Matches the bus wire rule: printable ASCII routing/message tokens. */
const TOKEN = /^[\x21-\x7e]+$/;

export interface GraphNodeOutcome { id: string; status: string; exitCode: number | null }
export interface GraphRunOutcome { status: string; nodes: GraphNodeOutcome[] }
export interface GraphObserveRequest {
  file: string;
  runId: string;
  from: string;
  to: string;
  apply: boolean;
  timeoutMs: number;
}
/** Preview posts nothing; a posted summary carries the deterministic id. */
export type GraphObserveDelivery =
  | { status: 'not-attempted' }
  | { status: 'preview'; envelope: { id: string; from: string; to: string; priority: 'P2'; ttl: number; bytes: number; nodeRows: number } }
  | BusInboxPost;
export interface GraphObservedRunResult {
  schema: 'fleet.graph-observe.run.v1';
  mode: 'preview' | 'apply';
  execution: GraphRunOutcome;
  delivery: GraphObserveDelivery;
}

function token(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && TOKEN.test(value);
}

/** Every flag and address is checked before a manifest is even read. */
export function validGraphObserveRequest(input: GraphObserveRequest): boolean {
  return isAbsolute(input.file)
    && token(input.runId, MAX_RUN_ID_LENGTH)
    && token(input.from, MAX_BUS_ADDRESS_LENGTH)
    && token(input.to, MAX_BUS_ADDRESS_LENGTH)
    && typeof input.apply === 'boolean'
    && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 && input.timeoutMs <= 3_600_000;
}

/** Bounded id/status/exitCode rows; node arrays never exceed the manifest cap. */
function boundedNodes(nodes: GraphNodeOutcome[] | undefined): GraphNodeOutcome[] {
  return (Array.isArray(nodes) ? nodes : []).slice(0, MAX_NODE_ROWS).map(node => ({
    id: typeof node?.id === 'string' ? node.id.slice(0, 64) : '',
    status: typeof node?.status === 'string' ? node.status.slice(0, 32) : '',
    exitCode: Number.isSafeInteger(node?.exitCode) ? node.exitCode : null,
  }));
}

/** Wire-checked candidate; null when the metadata cannot form a legal envelope. */
function buildSummary(runId: string, from: string, to: string, outcome: GraphRunOutcome): BusEnvelope | null {
  if (!token(runId, MAX_RUN_ID_LENGTH) || !token(from, MAX_BUS_ADDRESS_LENGTH) || !token(to, MAX_BUS_ADDRESS_LENGTH)) return null;
  const checked = validateBusEnvelope({
    id: `graph-observe:${runId}`, from, to, priority: 'P2', ttl: GRAPH_OBSERVE_TTL_MS,
    body: { schema: GRAPH_OBSERVE_SCHEMA, runId, status: String(outcome.status), nodes: boundedNodes(outcome.nodes) },
  });
  return checked.ok ? checked.value : null;
}

/**
 * Build the deterministic terminal-summary envelope for an already-executed
 * graph outcome. Same run-id + outcome always yields byte-identical wire JSON,
 * so transport dedupe recognizes a retried post as a duplicate. Returns null
 * when the outcome is not terminal or cannot fit the wire contract.
 */
export function terminalSummaryEnvelope(runId: string, from: string, to: string, outcome: GraphRunOutcome): BusEnvelope | null {
  return TERMINAL_STATUSES.includes(outcome?.status) ? buildSummary(runId, from, to, outcome) : null;
}

/**
 * Publish the terminal summary for a graph that already ran, without running
 * it again. Retry-safe: the deterministic id makes a repeated publish return
 * 'duplicate' instead of double-delivering.
 */
export function publishGraphTerminalSummary(runId: string, from: string, to: string, outcome: GraphRunOutcome,
  options: BusInboxOptions = {}): BusInboxPost {
  const envelope = terminalSummaryEnvelope(runId, from, to, outcome);
  return envelope ? appendBusInbox(envelope, options) : { status: 'invalid' };
}

/**
 * Run the manifest once (or preview it with zero children), then publish one
 * terminal summary. Execution and delivery stay separate: a refused graph can
 * never look delivered, and a completed graph with a failed post reports the
 * failure without rerunning the executor.
 */
export async function graphObservedRun(request: GraphObserveRequest, options: BusInboxOptions = {}): Promise<GraphObservedRunResult> {
  const mode = request?.apply === true ? 'apply' : 'preview';
  const result = (execution: GraphRunOutcome, delivery: GraphObserveDelivery): GraphObservedRunResult =>
    ({ schema: 'fleet.graph-observe.run.v1', mode, execution, delivery });
  if (!validGraphObserveRequest(request)) return result({ status: 'invalid', nodes: [] }, { status: 'not-attempted' });
  const execution = await graphArgvRun(request.file, request.apply, request.timeoutMs);
  if (execution.status === 'invalid') return result(execution, { status: 'not-attempted' });
  if (mode === 'apply') return result(execution, publishGraphTerminalSummary(request.runId, request.from, request.to, execution, options));
  const proposed = buildSummary(request.runId, request.from, request.to, execution);
  if (!proposed) return result(execution, { status: 'invalid' });
  const checked = validateBusEnvelope(proposed);
  return result(execution, {
    status: 'preview',
    envelope: { id: proposed.id, from: proposed.from, to: proposed.to, priority: 'P2', ttl: proposed.ttl, bytes: checked.ok ? checked.byteLength : 0, nodeRows: execution.nodes.length },
  });
}
