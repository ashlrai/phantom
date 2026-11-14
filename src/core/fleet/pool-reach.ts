/**
 * core/fleet/pool-reach.ts: sanitized, read-only evidence of whether the node
 * pool's primary and backup SSH aliases resolve to tailnet peers that are
 * online right now. Backs `ashlr fleet pool-reach [--json]`.
 *
 * The pool config names SSH aliases (the team device allowlist); the tailnet
 * reader names live peers. This module joins the two so an agent can see
 * whether failover targets are reachable before trusting them. Every
 * dependency is injected so tests never run real tailscale or touch the real
 * pool directory. A field that cannot be confirmed is "unknown" plus a
 * `reasons[]` entry; nothing is guessed, nothing throws, nothing is written.
 * Evidence only — it grants no SSH, dispatch or failover authority.
 */
import { readPoolConfig, type PoolConfig } from '../drive/nodes/pool-host.js';
import { sanitizeIdentityText, UNKNOWN } from './runtime-identity.js';
import {
  defaultTailnetPeersDeps,
  readTailnetPeers,
  type TailnetPeer,
  type TailnetPeers,
  type TailnetPeersDeps,
} from './tailnet-peers.js';

export interface PoolReachHost {
  slot: 'primary' | 'backup';
  alias: string;
  /** The peer (or self) name the alias matched; "unknown" when unmatched or ambiguous. */
  matched: string;
  online: boolean | 'unknown';
  lastSeen: string | 'unknown';
  ageSeconds: number | 'unknown';
  /** The alias names this computer: online is certain only when the complete peer list shows no competitor. */
  isSelf: boolean;
}

export interface PoolReach {
  asOf: string;
  self: string;
  role: string;
  hosts: PoolReachHost[];
  reasons: string[];
}

export interface PoolReachDeps {
  /** Reads ~/.ashlr/node-pool/config.json; may return null or throw. */
  readConfig(): PoolConfig | null;
  /** Dependencies for the shared sanitized tailscale status read. */
  peers: TailnetPeersDeps;
}

/** First DNS label of a name: "mac-backup.tail-x.ts.net" -> "mac-backup". */
const firstLabel = (name: string): string => name.split('.')[0] ?? name;

/**
 * Alias-to-name equality: the alias equals the peer name, the peer's first
 * DNS label, or the alias's first label equals the peer name (all
 * case-insensitive). First-label-vs-first-label is deliberately not a match:
 * "a.x" and "a.y" are different hosts.
 */
function aliasMatches(alias: string, name: string): boolean {
  const a = alias.toLowerCase();
  const n = name.toLowerCase();
  return a === n || a === firstLabel(n) || firstLabel(a) === n;
}

function reachForSlot(
  slot: 'primary' | 'backup',
  rawAlias: string,
  peers: TailnetPeers,
  home: string,
): { host: PoolReachHost; reason: string | null } {
  const alias = sanitizeIdentityText(rawAlias, home);
  // Peers named "unknown" are sanitization placeholders, not identities;
  // they can never confirm an alias.
  const matches = peers.peers.filter(peer => peer.name !== UNKNOWN && aliasMatches(alias, peer.name));
  const isSelf = peers.self !== UNKNOWN && aliasMatches(alias, peers.self);
  // tailnet-peers caps the peer list and records the truncation in reasons[];
  // a truncated set cannot prove an alias names exactly one host.
  const truncated = peers.reasons.some(reason => reason.startsWith('peers: truncated to '));
  // The shared reader reports an explicitly non-running backend as a reason
  // and drops retained online peers; self identity stays certain, but it must
  // not be promoted to online on stale backend evidence.
  const backendNotRunning = peers.reasons.some(reason => reason.startsWith('tailscale backend not running:'));

  const host: PoolReachHost = {
    slot,
    alias,
    matched: UNKNOWN,
    online: 'unknown',
    lastSeen: UNKNOWN,
    ageSeconds: UNKNOWN,
    isSelf,
  };
  let reason: string | null = null;
  if (isSelf && matches.length > 0) {
    // The alias names this computer but peers also claim it; which identity
    // the alias reaches is uncertain, so online stays unknown.
    reason = `${slot}: ${alias} matches this computer and ${matches.length} tailnet peers`;
    if (truncated) reason += '; peer list truncated, more matches may be hidden';
  } else if (matches.length > 1) {
    // Two peers claim the alias; naming one would be a guess.
    reason = `${slot}: ${alias} matches ${matches.length} tailnet peers`;
    if (truncated) reason += '; peer list truncated, more matches may be hidden';
  } else if (matches.length === 1) {
    if (truncated) {
      // A retained match cannot prove uniqueness: peers past the cap may
      // claim the same alias, so the identity stays unknown.
      reason = `${slot}: ${alias} matches a tailnet peer but the peer list is truncated; identity not proven unique`;
    } else {
      const peer = matches[0] as TailnetPeer;
      host.matched = peer.name;
      host.online = peer.online;
      host.lastSeen = peer.lastSeen;
      host.ageSeconds = peer.ageSeconds;
    }
  } else if (isSelf) {
    if (truncated) {
      // No retained peer claims the alias, but a capped list cannot prove
      // that peers past the cap do not; the self match stays evidence only,
      // so matched and online remain unknown until a complete read.
      reason = `${slot}: ${alias} names this computer but the peer list is truncated; identity not proven unique`;
    } else {
      host.matched = peers.self;
      if (backendNotRunning) {
        reason = `${slot}: ${alias} names this computer but the tailscale backend is not running; connectivity unknown`;
      }
    }
  } else {
    reason = truncated
      ? `${slot}: peer list truncated; cannot confirm ${alias}`
      : `${slot}: no tailnet peer named ${alias}`;
  }
  // Self is certain only when no peer competes for the alias and the peer
  // list is complete; online is certain only while the backend does not
  // report a non-running state.
  if (isSelf && matches.length === 0 && !truncated && !backendNotRunning) host.online = true;
  return { host, reason };
}

/**
 * Join the pool config (or its failure) with the tailnet peer evidence. Pure:
 * no I/O, never throws. `home` is used only to redact the home path from
 * printed aliases and reasons; callers that cannot supply it get IP redaction
 * only, which is still safe because validSshHost forbids '/' in aliases.
 */
export function joinPoolReach(
  config: PoolConfig | null,
  configError: string | null,
  peers: TailnetPeers,
  home = '',
): PoolReach {
  const reasons: string[] = [...peers.reasons];
  const reach: PoolReach = {
    asOf: peers.asOf,
    self: peers.self,
    role: config?.role ?? 'unknown',
    hosts: [],
    reasons,
  };
  if (configError !== null) {
    reasons.push(`pool config: ${sanitizeIdentityText(configError, home)}`);
    return reach;
  }
  if (config === null) {
    reasons.push('node pool not configured');
    return reach;
  }
  for (const [slot, alias] of [['primary', config.primary], ['backup', config.backup]] as const) {
    const { host, reason } = reachForSlot(slot, alias, peers, home);
    reach.hosts.push(host);
    if (reason !== null) reasons.push(reason);
  }
  return reach;
}

/** Join the live config read with the live tailnet read; never throws. */
export function readPoolReach(deps: PoolReachDeps): PoolReach {
  const home = (() => { try { return deps.peers.homeDir(); } catch { return ''; } })();
  let peers: TailnetPeers;
  try {
    peers = readTailnetPeers(deps.peers);
  } catch {
    peers = { asOf: UNKNOWN, self: UNKNOWN, peers: [], reasons: ['tailscale unavailable or status unreadable'] };
  }
  let config: PoolConfig | null = null;
  let configError: string | null = null;
  try {
    config = deps.readConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  return joinPoolReach(config, configError, peers, home);
}

/** Live dependencies: the real pool config read plus the shared tailscale reader. */
export function defaultPoolReachDeps(): PoolReachDeps {
  return { readConfig: readPoolConfig, peers: defaultTailnetPeersDeps() };
}
