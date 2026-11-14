/** One-line runtime evidence for the owner's "Phantom status" answer: which
 * host and build answered, how fresh its fleet-state read is, and whether the
 * Slack and iMessage bridges are live. The reply itself is the evidence, so
 * every interpolated piece is sanitized — no IP, home path or environment
 * value can reach it — and the line is capped at 240 chars.
 *
 * The readers (fleet/runtime-identity, fleet/channel-health) already redact;
 * this module redacts again so a hand-built report cannot smuggle a path.
 * formatRuntimeLine is pure; defaultRuntimeLine is the live-read seam the
 * Slack socket wiring passes in. */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readChannelHealth, type ChannelHealth, type ChannelHealthReport, type ChannelName } from '../fleet/channel-health.js';
import { defaultTailnetPeersDeps, readTailnetPeers, type TailnetPeers } from '../fleet/tailnet-peers.js';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity, sanitizeIdentityText, STALE_AFTER_SECONDS, type RuntimeIdentity } from '../fleet/runtime-identity.js';

export const RUNTIME_LINE_MAX_CHARS = 240;
/** readChannelHealth can spend ~2 s per pgrep; cap the whole read so the
 * answer never waits on the slowest evidence. */
export const RUNTIME_HEALTH_TIMEOUT_MS = 3_000;

const CHANNEL_LABELS: ReadonlyArray<readonly [ChannelName, string]> = [['slack', 'Slack'], ['imessage', 'iMessage']];
/** A user-home path from any account, not just the running one. */
const HOME_PATH = /(?:\/Users|\/home)\/[^/\s]+/g;
const MISSING_QUALIFIER = / (?:not running|not configured|unreadable|unverifiable)$/;

/** Second redact pass: sanitizeIdentityText drops IPs and the live home; the
 * pattern catches any other account's /Users|/home path. */
function redact(value: string, home: string): string {
  return sanitizeIdentityText(value, home).replace(HOME_PATH, '~');
}

/** "45s"/"2m"/"3h"/"2d" — the biggest whole unit only, so the line stays short. */
function ageText(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/** Age of the shared fleet-state file measured against the reply clock; the
 * reader's own ageSeconds is the fallback when its mtime is not parseable. */
function fleetAgeSeconds(state: RuntimeIdentity['fleetState'] | undefined, now: Date): number | null {
  if (!state) return null;
  const mtime = Date.parse(state.mtime);
  if (Number.isFinite(mtime)) return Math.max(0, Math.floor((now.getTime() - mtime) / 1000));
  return typeof state.ageSeconds === 'number' ? Math.max(0, state.ageSeconds) : null;
}

/** "bridge process" for "imessage bridge process not running": the channel is
 * named by the segment and the state already says BLOCKED/UNKNOWN. */
function shortMissing(channel: ChannelName, entry: string): string {
  const named = entry.startsWith(`${channel} `) ? entry.slice(channel.length + 1) : entry;
  return named.replace(MISSING_QUALIFIER, '');
}

function channelSegment(channel: ChannelHealth | undefined, label: string, home: string): string {
  if (!channel) return `${label} unknown`;
  const missing = channel.missing
    .map(entry => redact(shortMissing(channel.channel, entry), home))
    .filter(entry => entry !== '');
  return `${label} ${redact(channel.state, home)}${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''}`;
}

/** Counts only — a peer name never reaches the line. Empty peers with a reason
 * means the read failed; empty peers with no reason is an empty tailnet (0/0). */
function computersSegment(peers: TailnetPeers, home: string): string {
  const list = peers.peers;
  if (list.length === 0 && peers.reasons.length > 0) return redact(' · computers unknown', home);
  const online = list.filter(p => p.online === true).length;
  const unknown = list.filter(p => p.online === 'unknown').length;
  return redact(` · computers ${online}/${list.length} online${unknown > 0 ? ` (${unknown} unknown)` : ''}`, home);
}

/** Every unreadable piece prints "unknown". A non-null `peers` adds the
 * tailnet computers segment ahead of the channels so the cap trims channels first. */
export function formatRuntimeLine(identity: RuntimeIdentity | null, health: ChannelHealthReport | null, now: Date, peers: TailnetPeers | null = null): string {
  const home = (() => { try { return homedir(); } catch { return ''; } })();
  const host = redact(identity?.host ?? 'unknown', home);
  const installed = redact(identity?.installedVersion ?? 'unknown', home);
  const source = redact(identity?.sourceVersion ?? 'unknown', home);
  const drift = identity?.versionDrift === true ? ' drift' : '';

  let fleet = 'fleet state unknown';
  const age = fleetAgeSeconds(identity?.fleetState, now);
  if (age !== null) fleet = `fleet state ${ageText(age)} old${age > STALE_AFTER_SECONDS ? ' (stale)' : ''}`;

  const byName = new Map<ChannelName, ChannelHealth>(health?.channels.map(c => [c.channel, c]) ?? []);
  const channels = CHANNEL_LABELS.map(([name, label]) => channelSegment(byName.get(name), label, home)).join(' · ');

  const line = `Runtime: ${host} (${installed}, source ${source}${drift}), ${fleet}${peers ? computersSegment(peers, home) : ''} · ${channels}`;
  return line.length > RUNTIME_LINE_MAX_CHARS ? `${line.slice(0, RUNTIME_LINE_MAX_CHARS - 1)}…` : line;
}

/** The live seam: identity is sync and health is awaited under a 3 s cap, and
 * any may fail to null so the line degrades to "unknown" pieces rather
 * than disappearing. */
export async function defaultRuntimeLine(now: Date): Promise<string> {
  let identity: RuntimeIdentity | null = null;
  try {
    identity = readRuntimeIdentity({ ...defaultRuntimeIdentityDeps(), now: () => now });
  } catch { identity = null; }
  let health: ChannelHealthReport | null = null;
  try {
    health = await Promise.race([
      readChannelHealth({ now: () => now }),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), RUNTIME_HEALTH_TIMEOUT_MS).unref(); }),
    ]);
  } catch { health = null; }
  let peers: TailnetPeers | null = null;
  try {
    peers = readTailnetPeers({
      ...defaultTailnetPeersDeps(),
      now: () => now,
      exec: (cmd, args) => execFileSync(cmd, [...args], {
        encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      }),
    });
  } catch { peers = null; }
  return formatRuntimeLine(identity, health, now, peers);
}
