/**
 * observe.human.v1. One read-only snapshot for `phm observe --json`, the MCP
 * tools, and the desktop panes. A missing measurement is null and labeled
 * unknown. It is never stored as zero.
 */

export const OBSERVE_SCHEMA = 'observe.human.v1' as const;
export const HUMAN_STEPS_SCHEMA = 'ashlr.human-steps/v1' as const;
export const BOTTLENECKS_SCHEMA = 'bottlenecks.v1' as const;
export const OBSERVE_CLAIM_WINDOW_MS = 15 * 60_000;

/** 3.30.24 Fleet capture, 2026-11-09 00:24 ET. Counts are from that reading. */
export const OBSERVE_BASELINE = {
  capturedAt: '2026-11-09T00:24:51-05:00',
  appVersion: '3.30.24',
  sidebarPanels: 10,
  fleetPanesInBundle: 19,
  dataSources: 8,
  fields: { live: 4, unknown: 10, stale: 1, absent: 2 },
} as const;

export type ReadingState = 'live' | 'unknown' | 'pending';
export type ResourceState = 'coordinated' | 'idle' | 'duplicated' | 'no-headroom' | 'unknown';

export interface UsageWindow {
  lane: string;
  status: 'fresh' | 'unknown';
  headroom: number | null;
  used: number | null;
  limit: number | null;
  unit: string | null;
  resetAt: string | null;
  observedAt: string | null;
  source: string | null;
  staleAfter: string | null;
  burnPerHour: number | null;
  projectedUnused: number | null;
  alert: 'unused-before-reset' | null;
}

export interface RepoHeadline {
  repo: string;
  state: ReadingState;
  reason: string | null;
  opened: number | null;
  merged: number | null;
  failed: number | null;
  mergedPerDay: number | null;
  timeToMergeHours: number | null;
  queueWaitHours: number | null;
  ciDurationHours: number | null;
  changeFailureRate: number | null;
  trend: {
    mergedPerDay: 'up' | 'down' | 'flat' | 'unknown';
    changeFailureRate: 'up' | 'down' | 'flat' | 'unknown';
    days: { date: string; merged: number | null; changeFailures: number | null }[];
  };
}

export interface BottleneckItem {
  id: string;
  metric: string;
  value: number | null;
  unit: string;
  owner: string;
  before: number | null;
  after: number | null;
  verifiedAt: string | null;
}

export interface HumanDecision {
  id: string;
  at: string;
  kind: 'decision' | 'approval';
  title: string;
  actor: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'recorded';
}

export interface ResourceRow {
  id: string;
  label: string;
  state: ResourceState;
  reason: string;
  headroom: number | null;
  sessions: number | null;
  claims: number | null;
}

export interface ReleaseStage {
  id: string;
  label: string;
  state: 'ok' | 'blocked' | 'unknown';
  detail: string | null;
}

export interface ObserveSnapshot {
  schema: typeof OBSERVE_SCHEMA;
  generatedAt: string;
  readOnly: true;
  baseline: typeof OBSERVE_BASELINE;
  roster: {
    state: ReadingState;
    reason: string | null;
    source: string | null;
    sessions: {
      provider: string;
      sessionId: string;
      role: string | null;
      task: string | null;
      claim: string | null;
      status: string;
      model: string | null;
      ageSeconds: number | null;
    }[];
  };
  usage: { state: ReadingState; reason: string | null; windows: UsageWindow[] };
  resources: {
    windowMinutes: number;
    claims: 'available' | 'missing' | 'unavailable' | 'unknown';
    counts: { coordinated: number | null; idle: number | null; duplicated: number | null; unknown: number | null };
    items: ResourceRow[];
  };
  pulls: { state: ReadingState; reason: string | null; windowDays: number; repos: RepoHeadline[] };
  bottlenecks: { state: ReadingState; reason: string | null; source: string | null; top: BottleneckItem[] };
  humans: {
    state: ReadingState;
    reason: string | null;
    source: string | null;
    stepsRemaining: number | null;
    decisions: HumanDecision[];
  };
  graph: {
    state: ReadingState;
    reason: string | null;
    stages: ReleaseStage[];
    bottleneck: { nodeId: string; reason: string } | null;
  };
  coverage: {
    panels: number;
    sources: { id: string; state: ReadingState }[];
    fields: { live: number; unknown: number };
  };
}

export interface SessionDetail {
  schema: typeof OBSERVE_SCHEMA;
  state: ReadingState;
  reason: string | null;
  sessionId: string;
  provider: string | null;
  task: string | null;
  status: string | null;
  transcript: string | null;
}
