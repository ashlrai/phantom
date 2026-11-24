/**
 * `fleet_agent_identity` MCP adapter: one agent's bus identity card —
 * `busAgentView`, the same read `phm agents bus id show <ref>` serves. Every
 * other bus read resolves its agent/from/to/owner refs through the
 * server-owned identity registry and `fleet_bus_status` reports the
 * registry's health, but no tool answers "what is this ref" — the canonical
 * `agt_` id, handle, display name, aliases and runtimes the ref resolves to,
 * the `agent:<handle>` address mail to it carries, and the registry channels
 * whose member list names its handle — without shelling out to `phm`.
 *
 * `agent` is required — a handle, `agent:<handle>`, stable `agt_` id or
 * alias under the printable-label rule every bus read shares — because the
 * shared fleet server has no per-caller PHM_AGENT_ID, so the self path
 * `agents bus id show` with no ref would answer for the server, never the
 * caller. A ref that resolves to no identity answers `unknown`, a malformed
 * one `invalid`, an unreadable registry `unavailable` — never a guessed
 * match — and a missing registry answers `unknown` for every ref, the same
 * verified-empty verdict the CLI read reports. Every other key is refused
 * before the registry is touched. Read-only: no caller root, path or cwd is
 * accepted — the registry root stays server-owned — and the tool never
 * registers, aliases, joins channels or writes. An identity is a routing
 * name and the labels it answers to — never authentication, presence or
 * authority.
 */
import { busAgentView, type BusAgentView } from '../core/agents/bus-cli-adapters.js';
import type { AgentIdentity } from '../core/agents/bus-identity.js';

/** The printable-label rule `agent` shares with the other bus reads. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const IDENTITY_KEYS = new Set(['agent']);

export interface FleetAgentIdentityArgs {
  /**
   * Agent ref — handle, `agent:<handle>`, stable `agt_` id or alias —
   * resolved through the server-side registry; the card answers for exactly
   * this ref.
   */
  agent: string;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `agent` is
 * required — the shared server cannot resolve a caller's PHM_AGENT_ID — and
 * unknown keys, caller roots, wrong types and malformed labels are all
 * refused before the registry is touched.
 */
export function parseFleetAgentIdentityArgs(args: Record<string, unknown>): FleetAgentIdentityArgs | null {
  if (Object.keys(args).some(key => !IDENTITY_KEYS.has(key))) return null;
  const agent = args.agent;
  if (typeof agent !== 'string' || !BUS_LABEL.test(agent)) return null;
  return { agent };
}

export interface FleetAgentIdentityDeps {
  view?: typeof busAgentView;
}

export interface FleetAgentIdentityResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** The card's own status: ok, unknown, invalid, unavailable or unset — passed through untouched. */
  status: BusAgentView['status'];
  reason?: string;
  /** The requested ref on every variant that names one. */
  ref?: string;
  /** Always false on this tool — `agent` is required, so the PHM_AGENT_ID self path never runs. */
  self?: boolean;
  identity?: {
    id: string;
    handle: string;
    displayName: string;
    aliases: string[];
    runtimes: AgentIdentity['runtimes'];
    createdAt: number;
  };
  /** The `agent:<handle>` address mail to this identity carries. */
  address?: string;
  /** Registry channel names whose member list names the handle, in registry order. */
  channels?: string[];
}

/**
 * One identity-card read through the shared `busAgentView` projection — the
 * identical read `phm agents bus id show <ref>` runs, so ref validation,
 * `resolveAgent` exact-label matching, member-channel membership, the
 * `agent:<handle>` address and every status verdict can never diverge
 * between the CLI and this tool. Non-ok results pass through untouched with
 * their own status, ref, self and reason: an unregistered ref answers
 * `unknown`, a malformed one `invalid` (unreachable — the parser applies the
 * same label rule first) and an unreadable registry `unavailable` — never a
 * guessed match — while `ok` carries the resolved identity's id, handle,
 * display name, aliases, runtimes and creation time, its member channels
 * and its `agent:<handle>` address. Routing labels are data, never
 * authenticated identity.
 */
export async function readFleetAgentIdentity(
  args: FleetAgentIdentityArgs,
  deps: FleetAgentIdentityDeps = {},
): Promise<FleetAgentIdentityResult> {
  const view = deps.view ?? busAgentView;
  const card = view(args.agent);
  const base = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const, authority: 'none' as const,
    generatedAt: new Date().toISOString(),
  };
  if (card.status !== 'ok') {
    return {
      ...base, status: card.status, reason: card.reason,
      ...('ref' in card ? { ref: card.ref, self: card.self } : {}),
    };
  }
  return {
    ...base, status: 'ok' as const, ref: card.ref, self: card.self,
    identity: {
      id: card.identity.id, handle: card.identity.handle,
      displayName: card.identity.displayName, aliases: [...card.identity.aliases],
      runtimes: card.identity.runtimes.map(runtime => ({ ...runtime })),
      createdAt: card.identity.createdAt,
    },
    address: card.address, channels: [...card.channels],
  };
}
