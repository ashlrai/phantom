/**
 * `fleet_comms_health` MCP adapter: the comms transport health read —
 * `readTelegramHealth`, the same projection `phm comms health --json`
 * prints: the Telegram poller's last poll and last success timestamps,
 * whether a poll landed inside the liveness window, the last seen update
 * id, bot-token presence (a boolean — the value never leaves the
 * process) and the Leader tick state. `fleet_channels_overview` reports
 * each channel's configured/connected row and `fleet_comms_status` the
 * owner-thread adapters' rollup; neither answers "is the Telegram
 * poller actually polling and did the Leader tick last run" in one
 * call, so an MCP-connected agent had to shell out to `phm comms
 * health` for the one comms question no fleet read covered.
 *
 * No arguments: the config and comms state stay under the process home —
 * the same root `phm comms health` reads — and every key, caller root,
 * path, cwd or environment override is refused before the read runs.
 * Read-only: the projection only joins existing reads, writes nothing,
 * sends nothing, polls nothing and alters no comms configuration; a
 * throwing read reports `unavailable`, never an invented healthy
 * status. The bot token itself is never returned — only its presence
 * boolean — and the poll error field is the projection's fixed
 * value-free string. Routing labels are untrusted data; the tool
 * grants no send, pair, setup, dispatch or delivery authority.
 */
import { loadConfigReadOnly } from '../core/config.js';
import { readTelegramHealth } from '../core/integrations/telegram.js';
import type { AshlrConfig } from '../core/types.js';

/** The health takes no caller input — every store root stays server-owned. */
export function parseFleetCommsHealthArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export interface FleetCommsHealthDeps {
  /** Config loader; defaults to the read-only config read `phm comms health` shares. */
  cfg?: () => AshlrConfig;
  /** Health collector; defaults to the shared `readTelegramHealth` projection. */
  health?: (cfg: AshlrConfig) => ReturnType<typeof readTelegramHealth>;
}

interface FleetCommsHealthMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared health union with the MCP envelope metadata on every member. */
export type FleetCommsHealthResult = FleetCommsHealthMeta & (
  | ReturnType<typeof readTelegramHealth>
  | { status: 'unavailable'; reason: 'comms-health-unreadable' }
);

/**
 * One comms health read through the shared `readTelegramHealth`
 * projection — the identical read `phm comms health --json` runs, so
 * poller liveness, token presence and Leader tick state can never
 * diverge between the CLI and this tool. The projection's own fields
 * stay beside the envelope's `generatedAt`. A throwing read reports
 * `unavailable` — never an all-clear status passed off as fact.
 */
export async function readFleetCommsHealth(
  deps: FleetCommsHealthDeps = {},
): Promise<FleetCommsHealthResult> {
  const loadCfg = deps.cfg ?? loadConfigReadOnly;
  const health = deps.health ?? readTelegramHealth;
  const meta: FleetCommsHealthMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    return { ...meta, ...health(loadCfg()) };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'comms-health-unreadable' as const };
  }
}
