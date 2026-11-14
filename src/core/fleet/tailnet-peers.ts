/**
 * core/fleet/tailnet-peers.ts: sanitized, read-only evidence of which tailnet
 * peers this host can see right now. Backs `ashlr fleet tailnet-peers [--json]`.
 *
 * Every dependency is injected so tests never run real tailscale. Only
 * Self.HostName and each peer's HostName, OS, Online and LastSeen are read;
 * addresses, DNS names, keys and every other field are never copied out. A
 * field that cannot be read is the string "unknown" plus a `reasons[]` entry;
 * nothing is guessed and nothing throws.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { sanitizeIdentityText, UNKNOWN } from './runtime-identity.js';

/** Never report more peers than this; the rest are summarized in reasons[]. */
export const TAILNET_PEER_LIMIT = 64;
const TEXT_CAP = 120;
/** Tailscale's zero-value LastSeen: a never-seen peer, reported as unknown. */
const ZERO_LAST_SEEN_MS = Date.parse('0001-01-01T00:00:00Z');

export interface TailnetPeersDeps {
  now(): Date;
  /** Home directory, used only to redact it from output. */
  homeDir(): string;
  /** Runs a binary with fixed args and returns stdout; throws when missing or failing. */
  exec(cmd: string, args: readonly string[]): string;
}

export interface TailnetPeer {
  name: string;
  os: string;
  online: boolean | 'unknown';
  lastSeen: string | 'unknown';
  ageSeconds: number | 'unknown';
}

export interface TailnetPeers {
  asOf: string;
  self: string;
  peers: TailnetPeer[];
  reasons: string[];
}

function clean(value: unknown, home: string): string | null {
  if (typeof value !== 'string') return null;
  const text = sanitizeIdentityText(value.trim(), home).slice(0, TEXT_CAP);
  return text === '' ? null : text;
}

function toPeer(record: Record<string, unknown>, nowMs: number, home: string): TailnetPeer {
  const peer: TailnetPeer = {
    name: clean(record.HostName, home) ?? UNKNOWN,
    os: clean(record.OS, home) ?? UNKNOWN,
    online: typeof record.Online === 'boolean' ? record.Online : UNKNOWN,
    lastSeen: UNKNOWN,
    ageSeconds: UNKNOWN,
  };
  if (typeof record.LastSeen === 'string') {
    const ms = Date.parse(record.LastSeen.trim());
    if (Number.isFinite(ms) && ms !== ZERO_LAST_SEEN_MS) {
      peer.lastSeen = new Date(ms).toISOString();
      // A future LastSeen is an observation, not an age: clock skew could be
      // on either side, so ageSeconds stays unknown.
      if (Number.isFinite(nowMs) && ms <= nowMs) peer.ageSeconds = Math.floor((nowMs - ms) / 1000);
    }
  }
  return peer;
}

/** Online peers first, then name ascending. */
function byOnlineThenName(a: TailnetPeer, b: TailnetPeer): number {
  const rank = (peer: TailnetPeer) => (peer.online === true ? 0 : 1);
  return rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Parse raw `tailscale status --json` output into the sanitized contract. */
export function parseTailnetStatus(raw: string, now: Date, home: string): TailnetPeers {
  const reasons: string[] = [];
  const nowMs = now.getTime();
  const result: TailnetPeers = {
    asOf: Number.isFinite(nowMs) ? now.toISOString() : UNKNOWN,
    self: UNKNOWN,
    peers: [],
    reasons,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reasons.push('tailscale unavailable or status unreadable');
    return result;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reasons.push('tailscale unavailable or status unreadable');
    return result;
  }
  const status = parsed as { 
    Self?: { HostName?: unknown }; 
    Peer?: unknown;
    BackendState?: unknown;
  };
  result.self = clean(status.Self?.HostName, home) ?? UNKNOWN;

  // Check if the backend is not in a running state
  // Check if the backend is not in a running state
  const backendState = status.BackendState;
  if (typeof backendState === 'string' && backendState !== 'Running') {
    // Sanitize the backend state to prevent leaking sensitive information
    reasons.push(`tailscale backend not running: ${sanitizeIdentityText(backendState, home)}`);
  }

  const peerMap = status.Peer;
  if (typeof peerMap !== 'object' || peerMap === null || Array.isArray(peerMap)) {
    reasons.push('peers: status has no Peer map');
    return result;
  }

  const peers: TailnetPeer[] = [];
  for (const value of Object.values(peerMap)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const peer = toPeer(value as Record<string, unknown>, nowMs, home);
      // When backend is not running, peers that were online should not be considered current reachability
      if (typeof backendState === 'string' && backendState !== 'Running') {
        // Filter out peers that were online but backend is not running
        // This preserves the fact that the peer data was available but avoids false positive reachability
        if (peer.online === true) {
          // Keep reasons about the backend state but don't report online peers
          continue;
        }
      }
      peers.push(peer);
    }
  }
  peers.sort(byOnlineThenName);
  if (peers.length > TAILNET_PEER_LIMIT) {
    reasons.push(`peers: truncated to ${TAILNET_PEER_LIMIT} of ${peers.length}`);
    peers.length = TAILNET_PEER_LIMIT;
  }
  result.peers = peers;
  return result;
}

/** Read the peer list from `tailscale status --json`; never throws. */
export function readTailnetPeers(deps: TailnetPeersDeps): TailnetPeers {
  const home = (() => { try { return deps.homeDir(); } catch { return ''; } })();
  const now = deps.now();
  let raw: string;
  try {
    raw = deps.exec('tailscale', ['status', '--json']);
  } catch {
    const nowMs = now.getTime();
    return {
      asOf: Number.isFinite(nowMs) ? now.toISOString() : UNKNOWN,
      self: UNKNOWN,
      peers: [],
      reasons: ['tailscale unavailable or status unreadable'],
    };
  }
  return parseTailnetStatus(raw, now, home);
}

/** Live dependencies: `tailscale status --json` only, fixed args, 5 s cap. */
export function defaultTailnetPeersDeps(): TailnetPeersDeps {
  return {
    now: () => new Date(),
    homeDir: () => homedir(),
    exec: (cmd, args) => execFileSync(cmd, [...args], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }),
  };
}
