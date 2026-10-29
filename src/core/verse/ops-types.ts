/**
 * core/verse/ops-types.ts : the command-center projections the Ops section
 * reads (`/api/verse/ops/*`, ops-api.ts).
 *
 * The desktop app is the command center: one place to see the board, the
 * fleet's lanes and the router's choices, every repo's release state, and
 * the leaders' channel. Each view is a PROJECTION over the same buses the
 * CLI and Telegram already share : the team event log
 * (src/core/teams/store.ts), the fleet task queue and tick state
 * (src/core/fleet), the calibration harness (src/core/learn), and the
 * companion-coordination ledger : never a second store.
 *
 * Honesty rule (docs/VERSE-TELEMETRY-V2.md): `null` means UNKNOWN. A source
 * that could not be read reports `degraded`, never an empty list.
 *
 * BROWSER-SAFE: the web bundle imports this. Plain data and type-only
 * imports : no node: modules, ever.
 */
import type { FleetLaneState } from '../fleet/fleet-types.js';

export const VERSE_OPS_PATH = '/api/verse/ops';
export const VERSE_OPS_BOARD_PATH = `${VERSE_OPS_PATH}/board`;
export const VERSE_OPS_FLEET_PATH = `${VERSE_OPS_PATH}/fleet`;
export const VERSE_OPS_RELEASES_PATH = `${VERSE_OPS_PATH}/releases`;
export const VERSE_OPS_LEADERS_PATH = `${VERSE_OPS_PATH}/leaders`;
export const VERSE_OPS_LEADERS_MESSAGES_PATH = `${VERSE_OPS_PATH}/leaders/messages`;

/** The bus channel the Leaders view reads and posts to. */
export const OPS_LEADERS_CHANNEL = 'leaders';
/** Board reads this much dispatch history to resolve a task's seat/lane. */
export const OPS_BOARD_JOURNAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** The router view shows this much dispatch history. */
export const OPS_FLEET_JOURNAL_WINDOW_MS = 24 * 60 * 60_000;
export const OPS_FLEET_DECISION_LIMIT = 50;
export const OPS_BOARD_TASK_LIMIT = 200;
export const OPS_LEADERS_MESSAGE_LIMIT = 100;
export const OPS_MESSAGE_MAX_CHARS = 4_000;

export type OpsSourceState = 'healthy' | 'degraded';

// ---------------------------------------------------------------------------
// Board : tasks with assignee, estimate and outcome, per the handoff schema
// ---------------------------------------------------------------------------

export type OpsTaskSource = 'fleet' | 'handoff' | 'companion';

/**
 * Columns a task sits in. `held` covers anything parked or waiting on a
 * human: a held queue item, a handoff awaiting approval, a companion task
 * that needs attention.
 */
export type OpsBoardColumn = 'next' | 'active' | 'held' | 'done' | 'closed';

export interface OpsTaskRow {
  /** `fleet:<id>` / `handoff:<id>` / `companion:<id>` : unique across sources. */
  id: string;
  source: OpsTaskSource;
  title: string;
  /** owner/name, an enrolled path, or null when the task names no repo. */
  repo: string | null;
  column: OpsBoardColumn;
  /**
   * Who holds it now, in the handoff schema's sense: a team actor id
   * (`human:mason`, `agent:grok-bot/mason`), a companion
   * `provider/accountId/agentId`, or the fleet seat/lane a run was routed to.
   */
  assignee: string | null;
  /**
   * The estimate the task carries: fleet difficulty + size budget, a
   * companion cost cap or deadline, or null when the source records none.
   */
  estimate: string | null;
  /** The recorded outcome: a completed handoff's result, a report, a run state. */
  outcome: { state: string; text: string | null } | null;
  /** True when the row is parked on a human: an approval pending, attention flagged. */
  needsYou: boolean;
  updatedAt: string;
}

export interface OpsBoardV1 {
  v: 1;
  generatedAt: string;
  team: string;
  columns: Record<OpsBoardColumn, OpsTaskRow[]>;
  counts: Record<OpsBoardColumn, number>;
  sources: Record<OpsTaskSource, OpsSourceState>;
}

// ---------------------------------------------------------------------------
// Fleet & router : lanes, holds, seat decisions, A/B calibration results
// ---------------------------------------------------------------------------

export interface OpsRouteDecision {
  at: string;
  itemId: string;
  taskId: string | null;
  repo: string;
  title: string;
  /** The seat (account/model arm) the router chose; null when none was eligible. */
  seatId: string | null;
  /** The lane the run was dispatched on; null when it was held or skipped. */
  lane: string | null;
  dispatched: boolean;
  /** The router's own plain-language reason. */
  why: string | null;
  summary: string | null;
  /** Ranked eligible seats, best first. */
  candidates: string[];
  skipReason: string | null;
}

export interface OpsHeldItem {
  itemId: string;
  repo: string;
  title: string;
  holdKind: string;
  reason: string;
  nextEligibleAt: string | null;
  at: string;
}

/** One calibration A/B experiment: the two config arms and the verdict. */
export interface OpsExperimentV1 {
  id: string;
  hypothesisId: string | null;
  /** The two arms under test: the baseline config version vs the candidate. */
  arms: { base: string; candidate: string };
  status: string;
  pairs: number;
  wins: number;
  losses: number;
  ties: number;
  lift: { mean: number; ciLow: number; ciHigh: number } | null;
  verdict: string | null;
  reasons: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

export interface OpsFleetV1 {
  v: 1;
  generatedAt: string;
  /** The router's last tick; null = the daemon has never ticked. */
  tickAt: string | null;
  /** Per-lane slots/busy from that tick; null = unknown. */
  lanes: FleetLaneState[] | null;
  holdProduction: string | null;
  /** Items the router parked this tick, with hold reasons. */
  held: OpsHeldItem[];
  /** Recent seat decisions from the runs journal, newest first. */
  decisions: OpsRouteDecision[];
  /** Calibration experiments (the A/B arms + verdicts), newest first. */
  experiments: OpsExperimentV1[];
  sources: { tick: OpsSourceState; journal: OpsSourceState; learning: OpsSourceState };
}

// ---------------------------------------------------------------------------
// Releases : read-only release status per enrolled repo
// ---------------------------------------------------------------------------

export interface OpsRepoReleaseV1 {
  /** owner/name when the origin proves it, else the directory name. */
  repo: string;
  path: string;
  /** package.json version; null = none or unreadable. */
  version: string | null;
  /** Newest git tag; null = none or the repo could not be read. */
  latestTag: string | null;
  /** The workflow file that looks like a release pipeline, e.g. `release.yml`. */
  releaseWorkflow: string | null;
  /**
   * What `gh` reports; null = gh missing, unauthenticated or offline
   * (UNKNOWN, not "no releases").
   */
  gh: {
    latestRelease: { tag: string; name: string | null; publishedAt: string | null; draft: boolean; prerelease: boolean } | null;
    latestRun: { workflow: string; status: string; conclusion: string | null; at: string | null } | null;
  } | null;
  /** Anything an operator should know, e.g. "not a git repo". */
  notes: string[];
}

export interface OpsReleasesV1 {
  v: 1;
  generatedAt: string;
  repos: OpsRepoReleaseV1[];
  sourceState: OpsSourceState;
}

// ---------------------------------------------------------------------------
// Leaders' channel : the shared team bus, leaders' lane
// ---------------------------------------------------------------------------

export interface OpsLeaderMember {
  id: string;
  kind: 'human' | 'agent';
  role: string;
  provider: string | null;
  onBehalfOf: string | null;
  capabilities: string[];
  online: boolean;
  lastSeenAt: string;
  /** True when the member leads: an owner/admin, or an agent declaring the `leader` capability. */
  leader: boolean;
}

export interface OpsLeaderMessage {
  id: string;
  from: string;
  at: string;
  text: string;
}

export interface OpsLeadersV1 {
  v: 1;
  generatedAt: string;
  team: string;
  channel: string;
  leaders: OpsLeaderMember[];
  /** Every channel with traffic, so an empty leaders' lane can point at the busy ones. */
  channels: { channel: string; count: number }[];
  messages: OpsLeaderMessage[];
  openHandoffs: { id: string; from: string; to: string | null; title: string; state: string; updatedAt: string }[];
  pendingApprovals: { id: string; handoffId: string; action: string; requestedBy: string }[];
  /** False when the request is read-only (no dispatch): the composer disables itself. */
  canPost: boolean;
}

/** POST body for VERSE_OPS_LEADERS_MESSAGES_PATH. */
export interface OpsLeaderPostBody {
  text: string;
}
