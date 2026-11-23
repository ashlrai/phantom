/**
 * fleet_slack_status — the full offline Slack bridge status report for the
 * isolated fleet MCP server: the same buildSlackBridgeStatus projection
 * `phm channels slack status --json` serves — agent-network config and
 * [slack] section state, bridge ids, phm_ credential reference names (never
 * values), topic-to-channel mappings, team identity counts, comms
 * confirmation, journal state with ignored-reason buckets, reply-binding
 * counters, receipt-backed work items, readiness, the always-unknown
 * transport triple and the next step — in one call, where
 * fleet_channel_health answers only the LIVE/DEGRADED verdict and
 * fleet_slack_replies only the replies slice.
 *
 * Read-only and argument-free: agent-network.toml, comms.toml, the Slack
 * journal, send receipts and the work board all stay server-owned; no
 * caller root, path, cwd or option is accepted. Offline only — no socket,
 * no Web API call, no credential read; transport health stays 'unknown'
 * exactly like the CLI status. `config.path` reports its basename only —
 * the fleet surface never returns absolute host paths — while every other
 * field keeps the CLI report verbatim, including unknown states: a missing
 * or degraded journal stays missing/degraded and unreadable counts stay
 * absent, never an invented zero. A throwing or stalled read degrades to
 * { status: 'unknown', reason } with no counts and no raw exception text.
 */
import { basename } from 'node:path';
import { buildSlackBridgeStatus, type SlackBridgeStatus } from '../core/agents/slack-status.js';

export const FLEET_SLACK_STATUS_TIMEOUT_MS = 5_000;

/**
 * The CLI report with the one host-path field reduced to its basename:
 * the fleet surface reports which config file state was read, never where
 * the home directory lives. Every other field passes through verbatim.
 */
export function projectFleetSlackBridgeStatus(status: SlackBridgeStatus): SlackBridgeStatus {
  return { ...status, config: { ...status.config, path: basename(status.config.path) } };
}

/** The default evidence read: the offline bridge status, path-projected. */
async function readSlackStatusEvidence(): Promise<SlackBridgeStatus> {
  return projectFleetSlackBridgeStatus(buildSlackBridgeStatus());
}

/**
 * One bounded status read. A throw or timeout reports status 'unknown'
 * with a short code — never an invented ready flag, journal count or
 * reply tally, and never raw exception or path text.
 */
export async function readFleetSlackStatus(
  read: () => Promise<unknown> = readSlackStatusEvidence,
  timeoutMs = FLEET_SLACK_STATUS_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error && error.message === 'timeout' ? 'slack-status-timeout' : 'slack-status-unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
