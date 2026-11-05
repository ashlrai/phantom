/**
 * fleet_imessage_path / fleet_imessage_acks — read-only iMessage evidence for
 * the isolated fleet MCP server, so a shell-free Comms agent can diagnose the
 * local iMessage leg and inspect bounded acknowledgement evidence without
 * Messages access. Both delegate to the same collectors the CLI uses —
 * checkIMessagePath (`ashlr fleet imessage-path`) and readImessageAckEvidence
 * (`phm fleet imessage-acks`) — never a second classifier or reader, always at
 * the server-owned runs root (never a caller-supplied directory, root, cwd,
 * config, probe or send option).
 *
 * Path evidence keeps its fixed owner-only transport and unsupported
 * collaborator-delivery states verbatim. Ack evidence keeps its sourceState,
 * malformedRows and deliveryProof:false verbatim: an accepted or duplicate
 * acknowledgement is only a recorded intake receipt and never means a message
 * was sent or delivered. A throwing collector degrades to fixed unavailable
 * evidence — never raw exception text and never an invented healthy result.
 * Neither tool sends, polls, writes a cursor or state file, runs AppleScript,
 * reads message content or alters comms configuration.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkIMessagePath, type IMessagePathDeps } from '../core/comms/imessage-path-check.js';
import { readImessageAckEvidence, type AckEvidence } from '../core/comms/imessage-ack-evidence.js';

export const MAX_FLEET_IMESSAGE_ACKS = 100;
export const DEFAULT_FLEET_IMESSAGE_ACKS = 20;

export type FleetImessageSourceState = 'ok' | 'unavailable';
export type FleetImessagePathEvidence = ReturnType<typeof checkIMessagePath>;

export interface FleetImessageAcksArgs {
  /** Cap on returned acknowledgement rows; the collector keeps the newest. */
  limit: number;
}

export interface FleetImessagePathReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** 'ok' once the shared collector ran; 'unavailable' when it could not. */
  sourceState: FleetImessageSourceState;
  /** Scope marker survives even an unavailable read: owner transport only. */
  coverage: 'local-evidence-only-owner-transport-no-collaborator-delivery';
  /** The shared fixed-code path evidence; null when the collector could not run. */
  pathEvidence: FleetImessagePathEvidence | null;
}

export interface FleetImessageAcksReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  limit: number;
  /** 'ok' once the shared collector ran; 'unavailable' when it could not. */
  sourceState: FleetImessageSourceState;
  /** Scope marker survives even an unavailable read: receipts, never sends. */
  coverage: 'local-evidence-only-recorded-acks-never-sent-or-delivered';
  /** Bounded ack tail; null when the collector could not run. */
  ackEvidence: AckEvidence | null;
}

export interface FleetImessagePathDeps {
  /** iMessage runs root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  /** Path collector; default checkIMessagePath (test seam). */
  check?: (deps: IMessagePathDeps) => FleetImessagePathEvidence;
}

export interface FleetImessageAcksDeps {
  /** iMessage runs root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  /** Ack collector; default readImessageAckEvidence (test seam). */
  readAcks?: (limit: number, runsDir?: string) => Promise<AckEvidence>;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. This tool
 * takes no arguments — a caller-supplied dir, root, cwd, path, config, probe
 * or send option is an argument error, rejected before any filesystem read.
 */
export function parseFleetImessagePathArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

/**
 * `limit` is the only accepted key: an integer in 1..MAX_FLEET_IMESSAGE_ACKS,
 * defaulting to 20 when omitted. A caller-supplied dir, root, cwd, path or
 * send option is an argument error, rejected before any filesystem read.
 */
export function parseFleetImessageAcksArgs(args: Record<string, unknown>): FleetImessageAcksArgs | null {
  const limit = args['limit'] ?? DEFAULT_FLEET_IMESSAGE_ACKS;
  if (Object.keys(args).some(key => key !== 'limit') || args['limit'] === null ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_IMESSAGE_ACKS) return null;
  return { limit };
}

/**
 * Delegates to checkIMessagePath at the server-owned runs root and returns
 * its evidence verbatim: every state, reason and nextStep inside is already
 * a fixed code, so nothing private can leave through it — and the owner-only
 * transport plus unsupported collaborator-delivery states stay exactly as
 * reported. A throwing collector degrades to sourceState 'unavailable' with
 * null pathEvidence rather than healthy states or raw error text. Only read
 * paths are touched: no send, poll, cursor write or config change.
 */
export async function readFleetImessagePath(
  deps: FleetImessagePathDeps = {},
): Promise<FleetImessagePathReport> {
  const base = {
    schemaVersion: 1 as const,
    snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    generatedAt: new Date().toISOString(),
    coverage: 'local-evidence-only-owner-transport-no-collaborator-delivery' as const,
  };
  try {
    const pathEvidence = (deps.check ?? checkIMessagePath)({ runsRoot: deps.runsDir ?? join(homedir(), '.ashlr-runs') });
    return { ...base, sourceState: 'ok', pathEvidence };
  } catch {
    return { ...base, sourceState: 'unavailable', pathEvidence: null };
  }
}

/**
 * Delegates to readImessageAckEvidence at the server-owned runs root and
 * returns its evidence verbatim — sourceState (ok, missing, unreadable), the
 * bounded row projection, malformedRows and deliveryProof:false. A recorded
 * 'accepted' or 'duplicate' acknowledgement is intake evidence only and never
 * proves a send. A throwing collector degrades to sourceState 'unavailable'
 * with null ackEvidence rather than an invented empty tail or raw error text.
 */
export async function readFleetImessageAcks(
  input: FleetImessageAcksArgs,
  deps: FleetImessageAcksDeps = {},
): Promise<FleetImessageAcksReport> {
  const base = {
    schemaVersion: 1 as const,
    snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    generatedAt: new Date().toISOString(),
    limit: input.limit,
    coverage: 'local-evidence-only-recorded-acks-never-sent-or-delivered' as const,
  };
  try {
    const ackEvidence = await (deps.readAcks ?? readImessageAckEvidence)(
      input.limit, deps.runsDir ?? join(homedir(), '.ashlr-runs'));
    return { ...base, sourceState: 'ok', ackEvidence };
  } catch {
    return { ...base, sourceState: 'unavailable', ackEvidence: null };
  }
}
