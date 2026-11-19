/**
 * RQ-BUS-UNIFY-1 work view: one read answering "what work involves this
 * agent" across the surfaces it would otherwise check separately — the
 * unified inbox, the v2 work feed, the coordination claim table and the
 * wake queue. Read-only: no writes, claims, dispatch or authority. Owners
 * are matched through the identity registry, so routing labels are never
 * authentication, and an unreadable source stays unknown, never zero.
 */
import { listCoordination, type CoordinationView } from './claim-store.js';
import { readBusWorkFeed, type BusWorkFeedHold, type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import { agentLabels, readAgentRegistry, resolveAgent } from './bus-identity.js';
import { readAgentInbox, readAgentWakes, type InboxPage, type UnifiedBusOptions, type WakePage } from './bus-unified.js';
import type { WorkJob } from './bus-v2-schema.js';

export interface AgentWorkPage { after?: number; limit?: number; since?: number }

export type AgentWorkJobs =
  | { status: 'ok'; jobs: WorkJob[]; holds: BusWorkFeedHold[];
      claims: { source: 'missing' | 'available' | 'unavailable'; truncated: boolean };
      receipts: number; asOf: string }
  | { status: 'refused'; reason: string; receipts: number; asOf: string }
  | { status: 'unavailable' | 'retryable' | 'invalid'; asOf: string };

export interface AgentWorkClaims {
  /** missing: verified empty table; unavailable: held claims are unknown, not none. */
  source: 'missing' | 'available' | 'unavailable';
  claims: CoordinationView[];
}

export type AgentWorkView =
  | { v: 1; status: 'ok'; agent: string; identity: string; labels: string[];
      inbox: InboxPage; jobs: AgentWorkJobs; claims: AgentWorkClaims; wakes: WakePage }
  | { status: 'unknown-agent' | 'unavailable' | 'invalid'; reason: string };

function projectJobs(feed: BusWorkFeedReadResult, isMine: (owner: string) => boolean): AgentWorkJobs {
  if (feed.status === 'ok') {
    const mine = new Set(feed.jobs.filter(job => isMine(job.owner)).map(job => job.id));
    const joined = feed.claims ?? { source: 'unavailable' as const, holds: [] as BusWorkFeedHold[], truncated: false };
    return { status: 'ok',
      jobs: feed.jobs.filter(job => mine.has(job.id)),
      holds: joined.holds.filter(hold => mine.has(hold.jobId)),
      claims: { source: joined.source, truncated: joined.truncated },
      receipts: feed.receipts, asOf: feed.asOf };
  }
  if (feed.status === 'refused') {
    return { status: 'refused', reason: feed.reason, receipts: feed.receipts, asOf: feed.asOf };
  }
  return { status: feed.status, asOf: feed.asOf };
}

/**
 * One bounded read per source. The inbox page honors `after`/`limit`, wakes
 * honor `since`; jobs and claims always cover the whole retained snapshot.
 * A job or claim counts as the agent's when its owner label resolves to the
 * same registered identity — handle, `agent:<handle>`, stable id or alias.
 */
export function readAgentWorkView(ref: string, page: AgentWorkPage = {}, options: UnifiedBusOptions = {}): AgentWorkView {
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const target = resolveAgent(read.registry, ref);
  if (!target) return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
  const isMine = (owner: string): boolean => resolveAgent(read.registry, owner)?.id === target.id;

  const inbox = readAgentInbox(ref, { after: page.after, limit: page.limit }, options);
  const wakes = readAgentWakes(ref, page.since, options);

  const nowMs = (options.now ?? Date.now)();
  const feed = readBusWorkFeed({ root: options.root, now: () => nowMs, claims: true });
  const jobs = projectJobs(feed, isMine);

  const listed = listCoordination(options.root, nowMs);
  const claims: AgentWorkClaims = listed.source === 'available'
    ? { source: 'available', claims: listed.claims.filter(row => row.live && isMine(row.owner)) }
    : { source: listed.source, claims: [] };

  return { v: 1, status: 'ok', agent: target.handle, identity: target.id,
    labels: agentLabels(target), inbox, jobs, claims, wakes };
}
