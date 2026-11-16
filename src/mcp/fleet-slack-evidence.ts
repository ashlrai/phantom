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
 * claim. An optional `messageTs` (requiring `channelId`, matching the CLI
 * `--message` flag) selects exactly one request after collection: rows, counts
 * and freshness are recomputed for the selected rows only and a `selection`
 * echo is added. A throwing collector degrades to fixed unavailable evidence —
 * never raw exception text and never an invented healthy result. Never sends,
 * enqueues, claims, probes or writes.
 */
import { isSlackChannelId, isSlackTs } from '../core/agents/slack-network.js';
import { readSlackEvidenceBundle } from '../core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';

const SCOPE = 'Local journal and send evidence only; does not prove current runtime reachability, durable task ownership, or execution.';

export interface FleetSlackEvidenceArgs {
  /** Validated Slack thread root ts the bundle is restricted to. */
  thread: string;
  /** Optional Slack channel id; the collector filters rows and recomputes counts/freshness. */
  channelId?: string;
  /** Optional Slack message ts selecting one request; requires channelId (CLI `--message`). */
  messageTs?: string;
  /** Optional freshness bound; the collector reports fresh/stale/unknown. */
  maxAgeSeconds?: number;
}

export type FleetSlackEvidenceBundle = ReturnType<typeof readSlackEvidenceBundle>;
type FleetSlackEvidenceOptions = SlackRequestTraceOptions & { maxAgeSeconds?: number; channelId?: string };

export interface FleetSlackEvidenceDeps {
  /** Slack runs root; default server-owned root (test seam). */
  runsDir?: string;
  /** Send-store state root; default server-owned root (test seam). */
  stateRoot?: string;
  /** Clock override forwarded to the collector (test seam). */
  now?: () => Date;
  /** Bundle collector; default readSlackEvidenceBundle (test seam). */
  readBundle?: (thread: string, options: FleetSlackEvidenceOptions) => FleetSlackEvidenceBundle;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `thread` is a
 * required Slack ts, `channelId` an optional Slack channel id, `messageTs` an
 * optional Slack message ts that requires `channelId` (matching the CLI
 * `--message` rule) and `maxAgeSeconds` an optional positive safe integer;
 * every other key — including any caller root, path, cwd, send, enqueue or
 * claim option — is an argument error, rejected before any read.
 */
export function parseFleetSlackEvidenceArgs(args: Record<string, unknown>): FleetSlackEvidenceArgs | null {
  const thread = args['thread'];
  const channelId = args['channelId'];
  const messageTs = args['messageTs'];
  const maxAgeSeconds = args['maxAgeSeconds'];
  if (Object.keys(args).some(key => key !== 'thread' && key !== 'channelId' && key !== 'messageTs' && key !== 'maxAgeSeconds') ||
    args['thread'] === null || args['channelId'] === null || args['messageTs'] === null || args['maxAgeSeconds'] === null ||
    typeof thread !== 'string' || !isSlackTs(thread) ||
    (channelId !== undefined && (typeof channelId !== 'string' || !isSlackChannelId(channelId))) ||
    (messageTs !== undefined &&
      (typeof messageTs !== 'string' || !isSlackTs(messageTs) || channelId === undefined)) ||
    (maxAgeSeconds !== undefined &&
      (typeof maxAgeSeconds !== 'number' || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0))) return null;
  return { thread,
    ...(channelId !== undefined ? { channelId: channelId as string } : {}),
    ...(messageTs !== undefined ? { messageTs: messageTs as string } : {}),
    ...(maxAgeSeconds !== undefined ? { maxAgeSeconds: maxAgeSeconds as number } : {}) };
}

type FleetSlackEvidenceRow = FleetSlackEvidenceBundle['rows'][number];

function countSelectedRows(rows: readonly FleetSlackEvidenceRow[]) {
  const counts = { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  for (const row of rows) {
    if (row.outcome === 'answered') counts.answered++;
    else if (row.outcome === 'uncertain') counts.uncertain++;
    else if (row.outcome === 'bus-failed') counts.busFailed++;
    else counts.unanswered++;
  }
  return counts;
}

/**
 * The CLI `--message` post-filter: keep only the rows for the selected
 * channel+message, recompute counts, echo the selection and — when a
 * freshness bound was requested — recompute the verdict over the selected
 * rows only (empty selection is 'unknown', never inherited from siblings).
 */
function selectFleetSlackEvidenceMessage(
  bundle: FleetSlackEvidenceBundle,
  input: FleetSlackEvidenceArgs & { messageTs: string; channelId: string },
): FleetSlackEvidenceBundle {
  const rows = bundle.rows.filter(row => row.channelId === input.channelId && row.messageTs === input.messageTs);
  const maxAgeSeconds = input.maxAgeSeconds;
  const asOfMs = Date.parse(bundle.asOf);
  return {
    ...bundle,
    rows,
    counts: countSelectedRows(rows),
    selection: { channelId: input.channelId, messageTs: input.messageTs },
    ...(maxAgeSeconds !== undefined ? { freshness: {
      maxAgeSeconds,
      verdict: rows.length === 0 ? 'unknown' : rows.every(row => {
        const observed = Date.parse(row.at);
        const age = asOfMs - observed;
        return Number.isFinite(observed) && age >= 0 && age / 1000 <= maxAgeSeconds;
      }) ? 'fresh' : 'stale',
      basis: 'Persisted ingress observation times; asOf is collection time, not a live probe.',
    } } : {}),
  } as FleetSlackEvidenceBundle;
}

/**
 * Delegates to readSlackEvidenceBundle and returns its bundle verbatim —
 * schema, scope, thread, asOf, rows, counts, sources and optional freshness
 * keep their meaning. With `messageTs` the collected bundle is filtered to
 * the single selected request before returning, exactly like the CLI
 * `--message` flag. A throwing collector degrades to fixed unavailable
 * evidence: empty rows, degraded sources and sourceState 'unavailable',
 * never raw exception text, private paths or an invented answered result.
 */
export async function readFleetSlackEvidence(
  input: FleetSlackEvidenceArgs,
  deps: FleetSlackEvidenceDeps = {},
): Promise<FleetSlackEvidenceBundle> {
  const options: FleetSlackEvidenceOptions = {
    ...(deps.runsDir !== undefined ? { runsDir: deps.runsDir } : {}),
    ...(deps.stateRoot !== undefined ? { stateRoot: deps.stateRoot } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
  };
  let bundle: FleetSlackEvidenceBundle;
  try {
    bundle = await Promise.resolve((deps.readBundle ?? readSlackEvidenceBundle)(input.thread, options));
  } catch {
    let asOf: string;
    try { asOf = (deps.now ?? (() => new Date()))().toISOString(); }
    catch { asOf = new Date(0).toISOString(); }
    return {
      schema: 'phantom.fleet.slack-evidence.v1', scope: SCOPE, thread: input.thread,
      collectionScope: { thread: input.thread,
        ...(input.channelId !== undefined ? { channelId: input.channelId } : {}) },
      ...(input.messageTs !== undefined && input.channelId !== undefined
        ? { selection: { channelId: input.channelId, messageTs: input.messageTs } } : {}),
      asOf,
      rows: [], counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
      sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable',
    } as FleetSlackEvidenceBundle;
  }
  if (input.messageTs === undefined || input.channelId === undefined) return bundle;
  return selectFleetSlackEvidenceMessage(bundle, { ...input, messageTs: input.messageTs, channelId: input.channelId });
}
