/**
 * `fleet_comms_status` MCP adapter: the owner comms status —
 * `readOwnerCommsStatus`, the same `comms.owner-thread.status.v1`
 * projection `phm comms status --json`, the native `ashlr_comms` tool and
 * the owner-thread API serve. `fleet_comms_inbox` lists the pending owner
 * items; this is the operational rollup behind them: the kill-switch and
 * comms-pause verdicts the thread's adapters answer to (the same gates
 * `fleet_bus_status`'s sendGate reports for bus writes), the live plus
 * archived message count, inbound messages awaiting a recorded reply,
 * recorded replies whose fanout delivery evidence cannot confirm, the
 * per-channel owner adapter rollup (configured/enabled/halted with the
 * fixed reason and next step, secret handle names at most — never
 * values) and the teammate reply-gap read. An unreadable thread keeps
 * every count null — unknown stays unknown, never an invented zero.
 *
 * No arguments: the owner config dir and runs dir stay server-owned —
 * fixedOwnerConfigDir/fixedOwnerRunsDir resolve the real account home and
 * cannot be retargeted by HOME or ASHLR_* variables, the same roots the
 * native gateway's owner-thread tools use — so every key, caller root,
 * path, cwd or environment override is refused before the read runs.
 * Read-only: the projection joins existing reads, writes nothing and
 * sends nothing; message text never enters it (counts, channel names and
 * adapter metadata only), and a throwing read reports `unavailable`,
 * never an invented healthy status. Owner and routing labels are
 * untrusted data; the tool grants no reply, send, pairing, dispatch or
 * delivery authority.
 */
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { readOwnerCommsStatus, type OwnerCommsStatus } from '../core/comms/owner-thread.js';

/** The status takes no caller input — every store root stays server-owned. */
export function parseFleetCommsStatusArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetCommsStatusDeps {
  status?: () => OwnerCommsStatus | Promise<OwnerCommsStatus>;
}

interface FleetCommsStatusMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared status union with the MCP envelope metadata on every member. */
export type FleetCommsStatusResult = FleetCommsStatusMeta & (
  | OwnerCommsStatus
  | { status: 'unavailable'; reason: 'owner-comms-status-unreadable' }
);

/** The server-owned owner-thread options: real-home config and runs dirs, live halt/pause checks. */
function defaultCommsStatus(): OwnerCommsStatus {
  return readOwnerCommsStatus({
    runsDir: fixedOwnerRunsDir(),
    settings: loadOwnerThreadSettings(fixedOwnerConfigDir()),
  });
}

/**
 * One owner comms status through the shared `readOwnerCommsStatus` read —
 * the identical projection `phm comms status --json` runs, so kill/pause
 * verdicts, per-adapter states, awaiting/undelivered counts and the
 * teammate reply gap can never diverge between the CLI, the native
 * gateway and this tool. The projection's own fields stay beside the
 * envelope's `generatedAt`. A throwing read reports `unavailable` —
 * never an all-clear status passed off as fact.
 */
export async function readFleetCommsStatus(
  deps: FleetCommsStatusDeps = {},
): Promise<FleetCommsStatusResult> {
  const status = deps.status ?? defaultCommsStatus;
  const meta: FleetCommsStatusMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    return { ...meta, ...(await status()) };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'owner-comms-status-unreadable' as const };
  }
}
