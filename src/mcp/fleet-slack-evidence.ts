/**
 * fleet_slack_evidence — read-only durable Slack evidence bundle for the
 * isolated fleet MCP server, so a shell-free coordination agent can collect
 * the existing receipt-backed Slack evidence without a shell. Delegates to
 * the same collector the CLI uses — readSlackEvidenceBundle
 * (`phm fleet slack-evidence`) — never a second join, always at the
 * server-owned runs/state roots (never a caller-supplied directory, root, cwd,
 * path, send, enqueue or claim option). The bundle keeps its schema, scope,
 * asOf, rows, sources and optional freshness verbatim: persisted journal and
 * send-store evidence only, never a live reachability, ownership or execution
 * claim. A throwing collector degrades to fixed unavailable evidence — never
 * raw exception text and never an invented healthy result. Never sends,
 * enqueues, claims, probes or writes.
 */
import { isSlackTs } from '../core/agents/slack-network.js';
import { readSlackEvidenceBundle } from '../core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';

const SCOPE = 'Local journal and send evidence only; does not prove current runtime reachability, durable task ownership, or execution.';

export interface FleetSlackEvidenceArgs {
  /** Validated Slack thread root ts the bundle is restricted to. */
  thread: string;
  /** Optional freshness bound; the collector reports fresh/stale/unknown. */
  maxAgeSeconds?: number;
}

export type FleetSlackEvidenceBundle = ReturnType<typeof readSlackEvidenceBundle>;

export interface FleetSlackEvidenceDeps {
  /** Slack runs root; default server-owned root (test seam). */
  runsDir?: string;
  /** Send-store state root; default server-owned root (test seam). */
  stateRoot?: string;
  /** Clock override forwarded to the collector (test seam). */
  now?: () => Date;
  /** Bundle collector; default readSlackEvidenceBundle (test seam). */
  readBundle?: (thread: string, options: SlackRequestTraceOptions & { maxAgeSeconds?: number }) => FleetSlackEvidenceBundle;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `thread` is a
 * required Slack ts and `maxAgeSeconds` an optional positive safe integer;
 * every other key — including any caller root, path, cwd, send, enqueue or
 * claim option — is an argument error, rejected before any read.
 */
export function parseFleetSlackEvidenceArgs(args: Record<string, unknown>): FleetSlackEvidenceArgs | null {
  const thread = args['thread'];
  const maxAgeSeconds = args['maxAgeSeconds'];
  if (Object.keys(args).some(key => key !== 'thread' && key !== 'maxAgeSeconds') ||
    args['thread'] === null || args['maxAgeSeconds'] === null ||
    typeof thread !== 'string' || !isSlackTs(thread) ||
    (maxAgeSeconds !== undefined &&
      (typeof maxAgeSeconds !== 'number' || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0))) return null;
  return { thread, ...(maxAgeSeconds !== undefined ? { maxAgeSeconds: maxAgeSeconds as number } : {}) };
}

/**
 * Delegates to readSlackEvidenceBundle and returns its bundle verbatim —
 * schema, scope, thread, asOf, rows, counts, sources and optional freshness
 * keep their meaning. A throwing collector degrades to fixed unavailable
 * evidence: empty rows, degraded sources and sourceState 'unavailable', never
 * raw exception text, private paths or an invented answered result.
 */
export async function readFleetSlackEvidence(
  input: FleetSlackEvidenceArgs,
  deps: FleetSlackEvidenceDeps = {},
): Promise<FleetSlackEvidenceBundle> {
  const options: SlackRequestTraceOptions & { maxAgeSeconds?: number } = {
    ...(deps.runsDir !== undefined ? { runsDir: deps.runsDir } : {}),
    ...(deps.stateRoot !== undefined ? { stateRoot: deps.stateRoot } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
  };
  try {
    return await Promise.resolve((deps.readBundle ?? readSlackEvidenceBundle)(input.thread, options));
  } catch {
    let asOf: string;
    try { asOf = (deps.now ?? (() => new Date()))().toISOString(); }
    catch { asOf = new Date(0).toISOString(); }
    return {
      schema: 'phantom.fleet.slack-evidence.v1', scope: SCOPE, thread: input.thread, asOf,
      rows: [], counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
      sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable',
    } as FleetSlackEvidenceBundle;
  }
}
