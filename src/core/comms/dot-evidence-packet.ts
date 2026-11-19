/** One sanitized, read-only evidence packet answering "who is answering, what is
 * claimed, and who owns the Dot bridge". Every source is injected and wrapped:
 * a throwing or degraded source becomes `{ state: 'unavailable' }` plus a fixed
 * reason in `missing`. Thrown messages are never echoed (they can carry paths). */
import type { RuntimeIdentity } from '../fleet/runtime-identity.js';
import type { TailnetPeers } from '../fleet/tailnet-peers.js';
import type { SlackRequestTraceRead } from '../agents/slack-request-trace.js';
import type { FleetBoard } from '../fleet/coordination.js';
import { classifyWorkItem, type WorkItemState } from './work-item-state.js';

export const DOT_EVIDENCE_SCHEMA = 'fleet.dot-evidence.v1';

export interface Unavailable { state: 'unavailable' }
export interface DotEvidenceDeps {
  now(): Date;
  readRuntime(): RuntimeIdentity;
  readTailnet(): TailnetPeers;
  /** The coordination board, read without reaping. */
  readBoard(): FleetBoard;
  readSlack(): SlackRequestTraceRead;
  /** The bridge boundary (DOT_HANDOFF_SUMMARY.transport). */
  transport: { phantomToDot: string; teammateTransport: string; hostQualification: string };
  /** A real source naming the bridge owner, or null. Never invented. */
  bridgeOwner(): string | null;
}

export interface DotEvidencePacket {
  schema: typeof DOT_EVIDENCE_SCHEMA;
  asOf: string;
  runtime: Unavailable | {
    host: string; installedVersion: string; sourceVersion: string; versionDrift: boolean;
    fleetState: { ageSeconds: number | 'unknown'; stale: boolean | 'unknown' };
  };
  tailnet: Unavailable | { self: string; peers: { name: string; os: string; online: boolean | 'unknown'; ageSeconds: number | 'unknown' }[] };
  claims: Unavailable | { claims: { id: string; repo: string; task: string; agent: string; expiresAt: string; state: WorkItemState }[] };
  slack: Unavailable | { counts: SlackRequestTraceRead['counts']; sources: SlackRequestTraceRead['sources'] };
  bridge: { owner: string; transport: DotEvidenceDeps['transport'] };
  missing: string[];
}

const UNAVAILABLE: Unavailable = { state: 'unavailable' };
const iso = (ms: number): string => Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';

export function buildDotEvidencePacket(deps: DotEvidenceDeps): DotEvidencePacket {
  const missing: string[] = [];
  const guard = <T>(reason: string, read: () => T | null): T | Unavailable => {
    try {
      const value = read();
      if (value !== null) return value;
    } catch { /* fixed reason only */ }
    missing.push(reason);
    return UNAVAILABLE;
  };
  const now = deps.now();
  const nowMs = now.getTime();

  const runtime = guard('runtime-identity-unavailable', () => {
    const r = deps.readRuntime();
    if (r.host === 'unknown' || r.fleetState.ageSeconds === 'unknown') return null;
    if (r.fleetState.stale === true) missing.push('fleet-state-stale');
    return {
      host: r.host, installedVersion: r.installedVersion, sourceVersion: r.sourceVersion,
      versionDrift: r.versionDrift, fleetState: { ageSeconds: r.fleetState.ageSeconds, stale: r.fleetState.stale },
    };
  });
  const tailnet = guard('tailnet-unavailable', () => {
    const t = deps.readTailnet();
    if (t.self === 'unknown' || t.reasons.length > 0) return null;
    return { self: t.self, peers: t.peers.map(p => ({ name: p.name, os: p.os, online: p.online, ageSeconds: p.ageSeconds })) };
  });
  const claims = guard('claims-store-unreadable', () => {
    const board = deps.readBoard();
    if (board.state !== 'known') return null;
    return {
      claims: board.claims.filter(c => c.expiresAt > nowMs).map(c => ({
        id: c.id, repo: c.repo, task: String(c.task).slice(0, 200), agent: c.agent, expiresAt: iso(c.expiresAt),
        // The claim id is the durable receipt; the claim itself names the owner.
        state: classifyWorkItem({ id: c.id, receivedAt: iso(c.claimedAt), owner: c.agent, claimReceipt: c.id }, now.toISOString()).state,
      })),
    };
  });
  const slack = guard('slack-trace-unreadable', () => {
    const s = deps.readSlack();
    if (s.sources.journal === 'degraded' || s.sources.sends === 'degraded') return null;
    return { counts: s.counts, sources: s.sources };
  });

  let owner = 'unknown';
  try { owner = deps.bridgeOwner()?.trim() || 'unknown'; } catch { /* stays unknown */ }
  if (owner === 'unknown') missing.push('bridge-owner-unknown');

  return {
    schema: DOT_EVIDENCE_SCHEMA, asOf: iso(nowMs), runtime, tailnet, claims, slack,
    bridge: { owner, transport: deps.transport }, missing,
  };
}
