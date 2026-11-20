/**
 * The "Phantom status" reply body: five fixed lines built from plain data,
 * plus an optional sixth claims line. Pure: no I/O, no clock. Every line is a
 * fact or the word "unknown" with its reason; an unreadable source is never
 * rendered as 0 or "none".
 */
import type { NodeResultsSummary } from '../drive/nodes/results-read.js';
import type { DigestBlocker } from '../fleet/digest-blocker.js';
import { spanText } from '../fleet/merge-latency.js';
import { scrubSecrets } from '../util/scrub.js';

export type Fact<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface StatusDigestLane { lane: string; running: number; target: number; held: boolean; heldReason: string | null }

/** Durable bus work-claim counts at `asOfMs` (completion is a claim state, not verified work). */
export interface StatusDigestWorkClaims { live: number; completed: number; expired: number; owners: number; asOfMs: number }

/** Compact peer-bus health from the read-only peer ledger; only surfaced when it says something. */
export interface StatusDigestPeers { status: 'ok' | 'empty' | 'unavailable'; rateLimited: number; tightest: string | null; nearCap: number; reason?: string }

export interface StatusDigestInput {
  installedVersion: Fact<string>;
  /** Newest published release that carries the desktop asset. */
  publishedVersion: Fact<string>;
  /** Null when either version is unknown. */
  updatePending: boolean | null;
  mergesLastHour: Fact<number>;
  mergesLast24h: Fact<number>;
  /** True open-to-merge time (the PR's own created and merged times) over the last 24h; the median is null when no merged PR recorded both. Absent keeps the existing lines. */
  mergeTime?: Fact<{ medianSeconds: number | null; known: number; merged: number }>;
  lanes: Fact<StatusDigestLane[]>;
  /** Hard-limit asks only (secrets, money, outside sends, data destruction). */
  needsMason: Fact<number>;
  topP0: Fact<{ text: string; ageMs: number | null } | null>;
  /** Bus work claims; value null means no claims table exists yet. Absent field keeps the five original lines. */
  workClaims?: Fact<StatusDigestWorkClaims | null>;
  /** Peer bus health; null/undefined, empty and ok-with-headroom render nothing. */
  peers?: StatusDigestPeers | null;
  /** Node runner results on this computer; undefined keeps the existing lines, a throw is `{ status: 'unavailable' }`. */
  nodeRuns?: NodeResultsSummary | null;
  /** One plain sentence about a gap over 30 minutes that left work waiting ("The Mac slept 12:33 to 18:42; 6 hours of work did not run."); absent when none. */
  gapLine?: string;
  /** `disk_low: ...` when free disk will reach the lane freeze line in under 24 hours (or is already below it); absent otherwise. */
  diskLine?: string;
  /** The one thing costing the most launches in the last hour; its sentence is the digest's first line unless kind is none. */
  blocker?: DigestBlocker;
  /** `supply_low: Claude (0 queued, 16% left): add work` when a pool at risk of waste has under an hour of work queued; absent otherwise. */
  supplyLine?: string;
  /** The top waste alert (`pools.waste.v1`): "Gemini: 85% will go unused in 5 h. Sign in to Gemini once: run gemini in a terminal."; absent when none. */
  wasteLine?: string;
}

export const TOP_P0_MAX_CHARS = 120;

const unknown = (reason: string): string => `unknown (${reason.replace(/\s+/g, ' ').trim() || 'no reason recorded'})`;
const show = <T>(fact: Fact<T>, render: (value: T) => string): string => fact.ok ? render(fact.value) : unknown(fact.reason);

function age(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'age unknown';
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function truncateP0(text: string): string {
  const clean = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return clean.length > TOP_P0_MAX_CHARS ? `${clean.slice(0, TOP_P0_MAX_CHARS - 1)}…` : clean;
}

/** Same HH:MM Eastern wall clock the reply heading stamps. */
const claimsClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function buildStatusDigest(input: StatusDigestInput): string[] {
  const pending = input.updatePending === null ? '' : input.updatePending ? ' · update pending' : ' · up to date';
  const lanes = show(input.lanes, rows => {
    const live = rows.filter(row => !row.held && row.target > 0).map(row => `${row.lane} ${row.running}/${row.target}`);
    const held = rows.filter(row => row.held).map(row => `${row.lane} (${row.heldReason?.replace(/\s+/g, ' ').trim() || 'no reason recorded'})`);
    const parts = [live.join(', '), held.length ? `held: ${held.join(', ')}` : ''].filter(Boolean);
    return parts.join(' · ') || 'no lane has a target';
  });
  const blocker = input.blocker && input.blocker.kind !== 'none' ? input.blocker : undefined;
  const lines = [
    ...(blocker ? [blocker.sentence] : []),
    ...(input.wasteLine ? [input.wasteLine] : []),
    `App: installed ${show(input.installedVersion, v => v)} · published ${show(input.publishedVersion, v => v)}${pending}`,
    `Merges: ${show(input.mergesLastHour, n => `${n} in the last hour`)} · ${show(input.mergesLast24h, n => `${n} in the last 24h`)}`,
    ...(input.mergeTime ? [`Time to merge: ${show(input.mergeTime, t => t.medianSeconds === null ? `unknown (${t.merged} merged, none with GitHub's own created and merged times recorded)` : `median ${spanText(t.medianSeconds)} open to merge (${t.known} of ${t.merged} PRs known)`)}`] : []),
    `Lanes: ${lanes}`,
    `Needs Mason: ${show(input.needsMason, n => n === 0 ? 'none waiting' : `${n} hard-limit ask${n === 1 ? '' : 's'} waiting`)}`,
    `Top P0: ${show(input.topP0, p0 => p0 ? `${truncateP0(p0.text)} (${age(p0.ageMs)})` : 'none in the inbox')}`,
  ];
  if (input.workClaims !== undefined) {
    lines.push(`Claims: ${show(input.workClaims, claims => claims === null ? 'none recorded (no claims table)'
      : `${claims.live} live (${claims.owners} owner${claims.owners === 1 ? '' : 's'}) · ${claims.completed} completed · ${claims.expired} expired · as of ${claimsClock.format(new Date(claims.asOfMs))} ET, source bus claims`)}`);
  }
  const peers = input.peers;
  if (peers) {
    if (peers.status === 'unavailable') {
      lines.push(`Peers: ${unknown(peers.reason ?? '')}`);
    } else if (peers.rateLimited > 0 || peers.nearCap > 0) {
      const parts: string[] = [];
      if (peers.rateLimited > 0) {
        parts.push(`${peers.rateLimited} pair${peers.rateLimited === 1 ? '' : 's'} rate-limited${peers.tightest ? ` (${peers.tightest})` : ''}`);
      }
      if (peers.nearCap > 0) parts.push(`${peers.nearCap} conversation${peers.nearCap === 1 ? '' : 's'} near hop cap`);
      lines.push(`Peers: ${parts.join(' · ')}`);
    }
  }
  // The blocker line already says what the gap or disk line would.
  if (input.gapLine && blocker?.kind !== 'asleep') lines.push(input.gapLine);
  if (input.diskLine && blocker?.kind !== 'disk_low') lines.push(input.diskLine);
  if (input.supplyLine) lines.push(input.supplyLine);
  const runs = input.nodeRuns;
  if (runs) lines.push(nodeRunsLine(runs));
  return lines;
}

const utcClock = (iso: string): string => `${iso.slice(11, 16)}Z`;

/** Node runs line: source (this computer), window and as-of are always stated; artifacts are not completion proof. */
function nodeRunsLine(runs: NodeResultsSummary): string {
  if (runs.status === 'unavailable') return `Node runs unknown: ${(runs.reason ?? 'reader failed').replace(/\s+/g, ' ').trim()}`;
  if (runs.status === 'none') return 'Node runs: none recorded on this computer';
  const hours = Math.max(1, Math.round(runs.windowMs / 3_600_000));
  const extra = `${runs.unreadable > 0 ? `, ${runs.unreadable} unreadable` : ''}${runs.truncated ? ', newest 200 examined' : ''}`;
  const newest = runs.newest ? `, newest ${runs.newest.jobId} at ${utcClock(runs.newest.at)}` : '';
  return `Node runs (this computer, ${hours}h, as of ${utcClock(runs.asOf)}): ${runs.inWindow} result${runs.inWindow === 1 ? '' : 's'}${newest}${extra}; artifacts are not completion proof`;
}
