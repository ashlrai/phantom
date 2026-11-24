/**
 * `fleet_channels_overview` MCP adapter: the owner-channel matrix —
 * `readChannelsOverview`, the same `phantom.channels.v1` projection
 * `phm channels` and GET /api/channels serve. One row per channel the
 * owner can reach the Leader on (email, Telegram, iMessage, mobile,
 * desktop app, Phantom page, terminal, Slack) reporting connected,
 * not-set-up, failing or unknown with last inbound/outbound times, 24 h
 * message counts, verified senders, a masked address and the one plain
 * next step. `fleet_channel_health` answers only the Slack/iMessage
 * bridge slice; this is the whole matrix in one call, so an agent can
 * tell which channels can reach Mason — and which are silently down —
 * without shelling out to `phm channels`.
 *
 * No arguments: every store root — config, inbox, email-drop, bridge
 * health, remote-device registry — stays server-owned, so unknown keys,
 * caller roots, paths and working directories are refused before the
 * read runs. Read-only: the projection only joins existing reads, writes
 * nothing and sends nothing; addresses leave masked (last four
 * characters at most) and reasons/next steps are path- and
 * email-redacted by the projection itself, with the dispatcher's
 * per-string secret scrub on top. A channel whose source cannot be read
 * reports `unknown` — never a guessed zero — and a throwing overview
 * read reports `unavailable`, never an invented healthy matrix.
 */
import { readChannelsOverview, type ChannelsOverview } from '../core/fleet/channels-overview.js';

/** The overview takes no caller input — every store root stays server-owned. */
export function parseFleetChannelsOverviewArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetChannelsOverviewDeps {
  overview?: () => Promise<ChannelsOverview>;
}

interface FleetChannelsOverviewMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared overview union with the MCP envelope metadata on every member. */
export type FleetChannelsOverviewResult = FleetChannelsOverviewMeta & (
  | ChannelsOverview
  | { status: 'unavailable'; reason: 'channels-overview-unreadable' }
);

/**
 * One channel matrix through the shared `readChannelsOverview` read — the
 * identical projection `phm channels` runs, so per-channel states,
 * masked addresses and unknown-stays-unknown honesty can never diverge
 * between the CLI, the web pane and this tool. The overview's `at` stays
 * the projection's own read time beside the envelope's `generatedAt`.
 * A throwing read (unreadable config, inbox or status store the
 * projection does not isolate) reports `unavailable` — never an empty
 * or all-connected matrix passed off as fact.
 */
export async function readFleetChannelsOverview(
  deps: FleetChannelsOverviewDeps = {},
): Promise<FleetChannelsOverviewResult> {
  const overview = deps.overview ?? (() => readChannelsOverview());
  const meta: FleetChannelsOverviewMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    return { ...meta, ...(await overview()) };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'channels-overview-unreadable' as const };
  }
}
