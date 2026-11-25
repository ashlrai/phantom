import { readFleetEmpties } from '../core/fleet/empties.js';
/** Isolated MCP adapter: no gateway discovery, forwarding, or mutation tools. */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard, WORK_BOARD_DEFAULT_LIMIT, WORK_BOARD_MAX_LIMIT } from '../core/comms/work-board.js';
import { WORK_ITEM_STATES, type WorkItemState } from '../core/comms/work-item-state.js';
import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { buildSlackBridgeStatus } from '../core/agents/slack-status.js';
import { defaultTailnetPeersDeps, readTailnetPeers } from '../core/fleet/tailnet-peers.js';
import { defaultPoolReachDeps, readPoolReach } from '../core/fleet/pool-reach.js';
import { readFleetBoard, type FleetBoard } from '../core/fleet/coordination.js';
import { projectCoordinationClaims } from '../core/fleet/coordination-claims-view.js';
import { readClaimNoticeView } from '../core/fleet/claim-notice-view.js';
import { readChannelHealth } from '../core/fleet/channel-health.js';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity, sanitizeIdentityText } from '../core/fleet/runtime-identity.js';
import { scrubPrivateText } from '../core/util/scrub.js';
import { MAX_FLEET_TICKS, MAX_FLEET_BUS_HOPS, readFleetLoop, readFleetStatus, readFleetBusHops,
  parseFleetBusHopsArgs, type FleetBusHopsArgs } from './fleet.js';
import {
  MAX_FLEET_BUS_INBOX_READ, parseFleetBusInboxArgs, readFleetBusInbox, type FleetBusInboxArgs,
} from './fleet-inbox.js';
import {
  FLEET_AGENT_INBOX_LIMIT_DEFAULT, FLEET_AGENT_INBOX_LIMIT_MAX,
  parseFleetAgentInboxArgs, readFleetAgentInbox, type FleetAgentInboxArgs,
} from './fleet-agent-inbox.js';
import { parseFleetAgentWorkArgs, readFleetAgentWork, type FleetAgentWorkArgs } from './fleet-agent-work.js';
import { parseFleetAgentWakesArgs, readFleetAgentWakes, type FleetAgentWakesArgs } from './fleet-agent-wakes.js';
import { parseFleetAgentMessagesArgs, readFleetAgentMessages, type FleetAgentMessagesArgs } from './fleet-agent-messages.js';
import { parseFleetAgentChannelsArgs, readFleetAgentChannels, type FleetAgentChannelsArgs } from './fleet-agent-channels.js';
import { parseFleetAgentIdentityArgs, readFleetAgentIdentity, type FleetAgentIdentityArgs } from './fleet-agent-identity.js';
import { parseFleetAgentConversationsArgs, readFleetAgentConversations, type FleetAgentConversationsArgs } from './fleet-agent-conversations.js';
import { parseFleetAgentRosterArgs, readFleetAgentRoster } from './fleet-agent-roster.js';
import { CONVERSATION_STATES } from '../core/fleet/agent-conversation-model.js';
import {
  AGENT_MESSAGE_KINDS, AGENT_MESSAGES_CONTAINS_MAX, AGENT_MESSAGES_DEFAULT_LIMIT, AGENT_MESSAGES_MAX_LIMIT,
  parseSince,
} from '../core/fleet/agent-messages.js';
import {
  FLEET_BUS_CHANNEL_LIMIT_DEFAULT, FLEET_BUS_CHANNEL_LIMIT_MAX,
  parseFleetBusChannelArgs, readFleetBusChannel, type FleetBusChannelArgs,
} from './fleet-bus-channel.js';
import { parseFleetBusShowArgs, readFleetBusShow, type FleetBusShowArgs } from './fleet-bus-show.js';
import { parseFleetBusThreadArgs, readFleetBusThread, type FleetBusThreadArgs } from './fleet-bus-thread.js';
import { parseFleetBusStatusArgs, readFleetBusStatus } from './fleet-bus-status.js';
import { parseFleetBusClaimsArgs, readFleetBusClaims, type FleetBusClaimsArgs } from './fleet-bus-claims.js';
import { parseFleetCoordinationReturnsArgs, readFleetCoordinationReturns, type FleetCoordinationReturnsArgs } from './fleet-coordination-returns.js';
import { parseFleetBusBoardArgs, readFleetBusBoard, type FleetBusBoardArgs } from './fleet-bus-board.js';
import { parseFleetSeatHandoffsArgs, readFleetSeatHandoffs } from './fleet-seat-handoffs.js';
import { parseFleetBotSeatsArgs, readFleetBotSeats } from './fleet-bot-seats.js';
import { parseFleetChannelsOverviewArgs, readFleetChannelsOverview } from './fleet-channels-overview.js';
import { parseFleetRuntimeArgs, readFleetRuntime } from './fleet-runtime.js';
import { SURFACES } from '../core/fleet/surface-owner.js';
import { NOTE as SESSION_HANDOFF_NOTE, parseFleetSessionHandoffArgs, readFleetSessionHandoff } from './fleet-session-handoff.js';
import { NOTE as PEER_LEDGER_NOTE, parseFleetPeerLedgerArgs, readFleetPeerLedger, type FleetPeerLedgerArgs } from './fleet-peer-ledger.js';
import { NOTE as BRIDGE_CHECK_NOTE, parseFleetBridgeCheckArgs, readFleetBridgeCheck } from './fleet-bridge-check.js';
import { parseFleetSurfaceOwnerArgs, readFleetSurfaceOwner } from './fleet-surface-owner.js';
import { parseFleetClaimExecutionArgs, readFleetClaimExecution } from './fleet-claim-execution.js';
import { readFleetLanes } from './fleet-lanes.js';
import { parseFleetSelfTickLastArgs, readFleetSelfTickLast } from './fleet-self-tick.js';
import { parseFleetUnfedArgs, readFleetUnfed, type FleetUnfedArgs } from './fleet-unfed.js';
import { MAX_FLEET_RECHECK_HISTORY, DEFAULT_FLEET_RECHECK_HISTORY, parseFleetRecheckArgs, parseFleetRecheckHistoryArgs,
  readFleetRecheckTool, readFleetRecheckHistoryTool, type FleetRecheckHistoryArgs } from './fleet-recheck.js';
import { readFleetUsageResets } from './fleet-usage-resets.js';
import {
  MAX_FLEET_RESET_HISTORY, parseFleetResetHistoryArgs, readFleetResetHistory, type FleetResetHistoryArgs,
} from './fleet-reset-history.js';

import { parseFleetReviewPickArgs, readFleetReviewPick, type FleetReviewPickArgs } from './fleet-review-pick.js';
import { parseFleetOrderStateArgs, readFleetOrderState, type FleetOrderStateArgs } from './fleet-order-state.js';
import { parseFleetResetGroupAwaitArgs, readFleetResetGroupAwait, type FleetResetGroupAwaitArgs } from './fleet-reset-group-await.js';
import { RESET_GROUP_AWAIT_MAX_LANES } from '../core/fleet/reset-group-await.js';
import { LANE_ID_RE } from '../core/fleet/runs-lane-targets.js';
import { MAX_FLEET_RESET_AWAIT_MS, parseFleetResetAwaitArgs, readFleetResetAwait, type FleetResetAwaitArgs } from './fleet-reset-await.js';
import { MAX_FLEET_RESET_RELEASE_AWAIT_MS, parseFleetResetReleaseAwaitArgs, readFleetResetReleaseAwait,
  type FleetResetReleaseAwaitArgs } from './fleet-reset-release-await.js';
import { MAX_FLEET_RESET_FOLLOW_MS, parseFleetResetFollowArgs, readFleetResetFollow,
  type FleetResetFollowArgs } from './fleet-reset-follow.js';
import { MAX_FLEET_JOB_HISTORY, parseFleetJobHistoryArgs, readFleetJobHistory,
  type FleetJobHistoryArgs } from './fleet-job-history.js';
import { MAX_FLEET_JOB_HISTORY_BATCH_IDS, MAX_FLEET_JOB_HISTORY_BATCH_LIMIT,
  parseFleetJobHistoryBatchArgs, readFleetJobHistoryBatch,
  type FleetJobHistoryBatchArgs } from './fleet-job-history-batch.js';
import { JOB_BATCH_MAX } from '../core/fleet/job-history-batch.js';
import { JOB_LIMIT_MAX } from '../core/fleet/job-path-history.js';
import { JOB_OVERLAP_MIN_IDS } from '../core/fleet/job-overlap.js';
import { parseFleetJobOverlapArgs, readFleetJobOverlap, type FleetJobOverlapArgs } from './fleet-job-overlap.js';
import { MAX_FLEET_JOB_CURRENT_BATCH_IDS, parseFleetJobCurrentBatchArgs, readFleetJobCurrentBatch, type FleetJobCurrentBatchArgs } from './fleet-job-current-batch.js';
import { DEFAULT_FLEET_INTENT_LIMIT, MAX_FLEET_INTENT_LIMIT, parseFleetIntentReadArgs, readFleetIntent, type FleetIntentReadArgs } from './fleet-intent-read.js';
import { DEFAULT_FLEET_ORCHESTRATION_LIMIT, MAX_FLEET_ORCHESTRATION_LIMIT, parseFleetOrchestrationReadArgs, readFleetOrchestration, type FleetOrchestrationReadArgs } from './fleet-orchestration-read.js';
import { INTENT_STATUSES } from '../core/intent/schema.js';
import { parseFleetJobCurrentArgs, readFleetJobCurrent,
  type FleetJobCurrentArgs } from './fleet-job-current.js';
import { parseFleetJobCurrentSnapshotArgs, readFleetJobCurrentSnapshot, type FleetJobCurrentSnapshotArgs } from './fleet-job-current-snapshot.js';
import { parseFleetJobPatchArgs, readFleetJobPatch, type FleetJobPatchArgs } from './fleet-job-patch.js';
import { MAX_FLEET_PATH_HISTORY, parseFleetPathHistoryArgs, readFleetPathHistory,
  type FleetPathHistoryArgs } from './fleet-path-history.js';
import { MAX_FLEET_PATH_COCHANGES, parseFleetPathCochangesArgs, readFleetPathCochanges,
  type FleetPathCochangesArgs } from './fleet-path-cochanges.js';
import { parseFleetJobPrecheckArgs, readFleetJobPrecheck, type FleetJobPrecheckArgs } from './fleet-job-precheck.js';
import { readFleetMainHealthTool } from './fleet-main-health.js';
import { readFleetWasteRiskTool } from './fleet-waste-risk.js';
import { readFleetKeptTool } from './fleet-kept.js';
import { readFleetTrimTool } from './fleet-trim.js';
import { MAX_FLEET_EMAIL_OUTBOX_ENTRIES, parseFleetEmailOutboxArgs, readFleetEmailOutbox,
  type FleetEmailOutboxArgs } from './fleet-email-outbox.js';
import { MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS, MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS,
  DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, parseFleetEmailOutboxAwaitArgs, readFleetEmailOutboxAwait,
  type FleetEmailOutboxAwaitArgs } from './fleet-email-outbox-await.js';
import { MAX_FLEET_EMAIL_OUTBOX_BATCH_AWAIT_NAMES, parseFleetEmailOutboxBatchAwaitArgs,
  readFleetEmailOutboxBatchAwait, type FleetEmailOutboxBatchAwaitArgs } from './fleet-email-outbox-batch-await.js';
import { parseFleetEmailDiagnosisArgs, readFleetEmailDiagnosis } from './fleet-email-diagnosis.js';
import { parseFleetDiskForecastArgs, readFleetDiskForecast } from './fleet-disk-forecast.js';
import { parseFleetGmailArchivePlanLatestArgs, readFleetGmailArchivePlanLatest, type FleetGmailArchivePlanLatestArgs } from './fleet-gmail-archive-plan-latest.js';
import { parseFleetGmailTriageLatestArgs, readFleetGmailTriageLatest } from './fleet-gmail-triage-latest.js';
import { parseFleetCommsInboxArgs, readFleetCommsInbox, type FleetCommsInboxArgs } from './fleet-comms-inbox.js';
import { FLEET_WORK_FEED_LIMIT_DEFAULT, FLEET_WORK_FEED_LIMIT_MAX, parseFleetWorkFeedArgs,
  readFleetWorkFeed, type FleetWorkFeedArgs } from './fleet-work-feed.js';
import { BUS_WORK_FEED_CONTAINS_MAX } from '../core/agents/bus-work-feed-read.js';
import { PROVIDERS, WORK_RESULT_OUTCOMES, WORK_STATUSES, WORK_TIERS } from '../core/agents/bus-v2-schema.js';
import { COORDINATION_ORIGINS } from '../core/agents/claim-store.js';
import { UNIFIED_INBOX_CONTAINS_MAX, UNIFIED_INBOX_KINDS, UNIFIED_INBOX_SOURCES } from '../core/comms/unified-inbox.js';
import { BUS_PRIORITIES } from '../core/fleet/bus-envelope.js';
import { BUS_PROTOCOL_KINDS } from '../core/fleet/bus-protocol.js';
import { BUS_READ_CONTAINS_MAX, INBOX_KINDS } from '../core/agents/bus-unified.js';
import { parseFleetCommsReadinessArgs, readFleetCommsReadiness } from '../core/mcp/fleet-comms-readiness.js';
import { parseFleetCommsStatusArgs, readFleetCommsStatus } from './fleet-comms-status.js';
import { FLEET_COMMS_THREAD_LIMIT_DEFAULT, FLEET_COMMS_THREAD_LIMIT_MAX,
  parseFleetCommsThreadArgs, readFleetCommsThread, type FleetCommsThreadArgs } from './fleet-comms-thread.js';
import { FLEET_OWNER_HISTORY_LIMIT_DEFAULT, FLEET_OWNER_HISTORY_LIMIT_MAX,
  parseFleetOwnerHistoryArgs, readFleetOwnerHistory, type FleetOwnerHistoryArgs } from './fleet-owner-history.js';
import { parseFleetCommsHealthArgs, readFleetCommsHealth } from './fleet-comms-health.js';
import { OWNER_CHANNELS } from '../core/comms/leader-mailbox.js';
import { OWNER_THREAD_CONTAINS_MAX } from '../core/comms/owner-thread.js';
import { MAX_FLEET_IMESSAGE_ACKS, parseFleetImessageAcksArgs, parseFleetImessagePathArgs,
  readFleetImessageAcks, readFleetImessagePath, type FleetImessageAcksArgs } from './fleet-imessage-evidence.js';
import { DEFAULT_FLEET_IMESSAGE_TASKS, MAX_FLEET_IMESSAGE_TASKS, parseFleetImessageTasksArgs,
  readFleetImessageTasks, type FleetImessageTasksArgs } from './fleet-imessage-tasks.js';
import { parseFleetSlackEvidenceArgs, readFleetSlackEvidence,
  type FleetSlackEvidenceArgs } from './fleet-slack-evidence.js';
import { readFleetSlackStatus } from './fleet-slack-status.js';

import { FLEET_BATCH_LABEL_PATTERN, parseFleetJobPrecheckBatchArgs, readFleetJobPrecheckBatch, type FleetJobPrecheckBatchArgs } from './fleet-job-precheck-batch.js';
import { JOB_PRECHECK_BATCH_MAX } from '../core/fleet/job-precheck-batch.js';
import { parseFleetCiResumeInputsArgs, readFleetCiResumeInputs, type FleetCiResumeInputsArgs } from './fleet-ci-resume-inputs.js';
import { parseFleetCiReceiptAwaitArgs, readFleetCiReceiptAwait, type FleetCiReceiptAwaitArgs } from './fleet-ci-receipt-await.js';
import { parseFleetCiReceiptAwaitBatchArgs, readFleetCiReceiptAwaitBatch,
  type FleetCiReceiptAwaitBatchArgs } from './fleet-ci-receipt-await-batch.js';
import { CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MAX_POLL_MS, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MIN_POLL_MS } from '../core/fleet/ci-receipt-await.js';
import { CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS } from '../core/fleet/ci-receipt-await-batch.js';

import { retryStagingInventory } from './fleet-staging-inventory-retry.js';
import { parseStagingBatchArgs, readStagingBatch, type StagingScanner } from './fleet-staging-inventory-batch.js';
import { parseFleetStagingInventoryArgs, readFleetStagingInventory, type FleetStagingInventoryArgs } from './fleet-staging-inventory.js';
import { FLEET_RELEASE_CANDIDATE_REPO_PATTERN, FLEET_RELEASE_CANDIDATE_TAG_PATTERN,
  parseFleetReleaseCandidateArgs, readFleetReleaseCandidate,
  type FleetReleaseCandidateArgs } from './fleet-release-candidate.js';

export const MAX_FLEET_OUTPUT_BYTES = 64 * 1024;

export interface FleetWorkBoardArgs {
  /** Cap on returned board items, applied newest-first after filtering. */
  limit: number;
  /** Exact channel_ref filter; omitted keeps every channel. */
  thread?: string;
  /** Classified-state filter; omitted keeps every state. */
  state?: WorkItemState;
  /** Epoch-ms floor on the request's recorded receivedAt (inclusive), resolved
   * from the shared `15m|2h|1d|epoch-ms|ISO` grammar at parse time. */
  since?: number;
  /** Epoch-ms ceiling on the request's recorded receivedAt (exclusive),
   * composing with `since` into one `[since, before)` window. */
  before?: number;
}

const WORK_BOARD_ARG_KEYS = new Set(['limit', 'thread', 'state', 'since', 'before']);

/** Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so unknown keys — including any caller `root` —,
 * out-of-range limits, oversized or non-string threads, and since/before
 * values outside the shared time grammar are rejected before the store is
 * touched. The board always reads the server-owned default fleet root. */
function parseFleetWorkBoardArgs(args: Record<string, unknown>): FleetWorkBoardArgs | null {
  const limit = args['limit'] ?? WORK_BOARD_DEFAULT_LIMIT, thread = args['thread'], state = args['state'],
    sinceRaw = args['since'], beforeRaw = args['before'];
  if (Object.keys(args).some(key => !WORK_BOARD_ARG_KEYS.has(key)) ||
    args['limit'] === null || args['thread'] === null || args['state'] === null ||
    args['since'] === null || args['before'] === null ||
    typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > WORK_BOARD_MAX_LIMIT ||
    thread !== undefined && (typeof thread !== 'string' || thread.length > 512) ||
    state !== undefined && (typeof state !== 'string' || !(WORK_ITEM_STATES as readonly string[]).includes(state)) ||
    sinceRaw !== undefined && typeof sinceRaw !== 'string' ||
    beforeRaw !== undefined && typeof beforeRaw !== 'string') return null;
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw as string);
  const before = beforeRaw === undefined ? undefined : parseSince(beforeRaw as string);
  if (since !== undefined && (since === null || !Number.isSafeInteger(since) || since < 0)) return null;
  if (before !== undefined && (before === null || !Number.isSafeInteger(before) || before < 0)) return null;
  return { limit, thread: thread as string | undefined, state: state as WorkItemState | undefined,
    since: since ?? undefined, before: before ?? undefined };
}

/** One bounded board read through the canonical listWorkBoard listing — the
 * same classifier as `ashlr fleet work-board`, never a second one — with the
 * invocation clock stamped as `asOf`. */
async function readFleetWorkBoard(input: FleetWorkBoardArgs) {
  const now = Date.now();
  const board = listWorkBoard({ root: join(ashlrHome(), 'fleet'), now, limit: input.limit, channelRef: input.thread,
    state: input.state, ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.before === undefined ? {} : { before: input.before }) });
  return { ...board, asOf: new Date(now).toISOString() };
}

/** Same bound as the verse comms-status API uses for the bridge health read. */
const CHANNEL_HEALTH_TIMEOUT_MS = 5_000;
const SLACK_REPLIES_TIMEOUT_MS = 5_000;

/** Read only the server-owned default ledger; callers cannot select its location. */
function readFleetCoordinationClaims() {
  const now = Date.now();
  let board: FleetBoard | null;
  try { board = readFleetBoard({ now, reap: false }); } catch { board = null; }
  return projectCoordinationClaims(board, now);
}

/** Runtime identity: host, installed version and fleet-state freshness, sanitized by the reader. */
async function readFleetRuntimeIdentity() {
  return readRuntimeIdentity(defaultRuntimeIdentityDeps());
}

/** The bridge report with runtimeHost redacted like runtime-identity output (as the verse API does). */
async function readSanitizedChannelHealth() {
  const report = await readChannelHealth();
  const home = homedir();
  return {
    ...report,
    channels: report.channels.map(channel => ({
      ...channel,
      runtimeHost: channel.runtimeHost === null ? null : sanitizeIdentityText(channel.runtimeHost, home),
    })),
  };
}

/** Bounded read. A throw or timeout is reported as status 'unknown' with a
 * short code — never an invented report. */
async function readBounded(
  read: () => Promise<unknown>,
  code: string,
  timeoutMs = CHANNEL_HEALTH_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error && error.message === 'timeout' ? `${code}-timeout` : `${code}-unavailable` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const readFleetChannelHealth = (read: () => Promise<unknown> = readSanitizedChannelHealth, timeoutMs?: number) =>
  readBounded(read, 'channel-health', timeoutMs);

/** Sanitized tailnet peers (reader never throws; deps are fixed, no caller input). */
const readFleetTailnetPeers = (read: () => Promise<unknown> = async () => readTailnetPeers(defaultTailnetPeersDeps()), timeoutMs?: number) =>
  readBounded(read, 'tailnet-peers', timeoutMs);

/** Pool reachability join (reader never throws; deps are fixed, no caller input). */
const readFleetPoolReach = (read: () => Promise<unknown> = async () => readPoolReach(defaultPoolReachDeps()), timeoutMs?: number) =>
  readBounded(read, 'pool-reach', timeoutMs);

/** Slack reply binding: the `replies` section of the offline bridge status plus its `at`. */
async function readSlackRepliesEvidence() {
  const status = buildSlackBridgeStatus();
  const { state, answered, unanswered, oldestUnansweredAt, uncertainSends, unverified, uncertainRequests, rejected, futureDated, unansweredSample, busFailed, busFailedSample } = status.replies;
  return { asOf: status.at, state, answered, unanswered, oldestUnansweredAt, uncertainSends, unverified, uncertainRequests, rejected, futureDated, unansweredSample, busFailed, busFailedSample };
}

/** Bounded Slack-replies read. A throw or timeout is reported as status
 * 'unknown' with a short code — never an invented answered/unanswered count. */
async function readFleetSlackReplies(
  read: () => Promise<unknown> = readSlackRepliesEvidence,
  timeoutMs = SLACK_REPLIES_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error && error.message === 'timeout' ? 'slack-replies-timeout' : 'slack-replies-unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read the desktop claim-notice evidence without exposing reader failures. */
async function readFleetClaimNotices(
  read: () => Promise<unknown> = () => readClaimNoticeView(),
): Promise<unknown> {
  const timeout = Symbol('claim-notices-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeout), 5_000);
      }),
    ]);
  } catch (error) {
    return { status: 'unknown', reason: error === timeout ? 'claim-notices-timeout' : 'claim-notices-unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface FleetReaders {
  stagingScanner?: StagingScanner;
  stagingInventory?: (input: FleetStagingInventoryArgs) => Promise<unknown>;
  status: () => Promise<unknown>;
  empties?: (hours: number) => Promise<unknown>;
  loop: (limit: number) => Promise<unknown>;
  bus?: (input: FleetBusHopsArgs) => Promise<unknown>;
  hostRuns?: () => Promise<unknown>;
  busInbox?: (input: FleetBusInboxArgs) => Promise<unknown>;
  agentInbox?: (input: FleetAgentInboxArgs) => Promise<unknown>;
  agentWork?: (input: FleetAgentWorkArgs) => Promise<unknown>;
  agentWakes?: (input: FleetAgentWakesArgs) => Promise<unknown>;
  agentMessages?: (input: FleetAgentMessagesArgs) => Promise<unknown>;
  agentChannels?: (input: FleetAgentChannelsArgs) => Promise<unknown>;
  agentIdentity?: (input: FleetAgentIdentityArgs) => Promise<unknown>;
  agentConversations?: (input: FleetAgentConversationsArgs) => Promise<unknown>;
  agentRoster?: () => Promise<unknown>;
  busChannel?: (input: FleetBusChannelArgs) => Promise<unknown>;
  busShow?: (input: FleetBusShowArgs) => Promise<unknown>;
  busThread?: (input: FleetBusThreadArgs) => Promise<unknown>;
  busStatus?: () => Promise<unknown>;
  busClaims?: (input: FleetBusClaimsArgs) => Promise<unknown>;
  coordinationReturns?: (input: FleetCoordinationReturnsArgs) => unknown;
  busBoard?: (input: FleetBusBoardArgs) => Promise<unknown>;
  seatHandoffs?: () => Promise<unknown>;
  botSeats?: () => Promise<unknown>;
  workFeed?: (input: FleetWorkFeedArgs) => Promise<unknown>;
  workBoard?: (input: FleetWorkBoardArgs) => Promise<unknown>;
  runtime?: () => Promise<unknown>;
  peerLedger?: (input: FleetPeerLedgerArgs) => unknown;
  sessionHandoff?: (input: { job: string }) => unknown;
  surfaceOwner?: (surface: string) => Promise<unknown>;
  claimExecution?: () => Promise<unknown>;
  runtimeIdentity?: () => Promise<unknown>;
  channelHealth?: () => Promise<unknown>;
  channelsOverview?: () => Promise<unknown>;
  tailnetPeers?: () => Promise<unknown>;
  poolReach?: () => Promise<unknown>;
  reviewPick?: (args: FleetReviewPickArgs) => Promise<unknown>;
  orderState?: (args: FleetOrderStateArgs) => Promise<unknown>;
  slackReplies?: () => Promise<unknown>;
  slackStatus?: () => Promise<unknown>;
  claimNotices?: () => Promise<unknown>;
  lanes?: () => Promise<unknown>;
  unfed?: (input: FleetUnfedArgs) => Promise<unknown>;
  selfTickLast?: () => Promise<unknown>;
  usageResets?: () => Promise<unknown>;
  resetHistory?: (input: FleetResetHistoryArgs) => Promise<unknown>;
  resetGroupAwait?: (input: FleetResetGroupAwaitArgs) => Promise<unknown>;
  resetAwait?: (input: FleetResetAwaitArgs) => Promise<unknown>;
  resetReleaseAwait?: (input: FleetResetReleaseAwaitArgs) => Promise<unknown>;
  resetFollow?: (input: FleetResetFollowArgs) => Promise<unknown>;
  jobHistory?: (input: FleetJobHistoryArgs) => Promise<unknown>;
  jobHistoryBatch?: (input: FleetJobHistoryBatchArgs) => Promise<unknown>;
  jobCurrentBatch?: (input: FleetJobCurrentBatchArgs) => Promise<unknown>;
  jobCurrent?: (input: FleetJobCurrentArgs) => Promise<unknown>;
  jobCurrentSnapshot?: (input: FleetJobCurrentSnapshotArgs) => Promise<unknown>;
  jobPatch?: (input: FleetJobPatchArgs) => Promise<unknown>;
  jobOverlap?: (input: FleetJobOverlapArgs) => Promise<unknown>;
  pathHistory?: (input: FleetPathHistoryArgs) => Promise<unknown>;
  pathCochanges?: (input: FleetPathCochangesArgs) => Promise<unknown>;
  jobPrecheck?: (input: FleetJobPrecheckArgs) => Promise<unknown>;
  jobPrecheckBatch?: (input: FleetJobPrecheckBatchArgs) => Promise<unknown>;
  mainHealth?: () => Promise<unknown>;
  wasteRisk?: () => Promise<unknown>;
  kept?: () => Promise<unknown>;
  trim?: () => Promise<unknown>;
  emailOutbox?: (input: FleetEmailOutboxArgs) => Promise<unknown>;
  emailOutboxAwait?: (input: FleetEmailOutboxAwaitArgs, signal: AbortSignal) => Promise<unknown>;
  emailOutboxBatchAwait?: (input: FleetEmailOutboxBatchAwaitArgs, signal: AbortSignal) => Promise<unknown>;
  emailDiagnosis?: () => Promise<unknown>;
  gmailTriageLatest?: () => Promise<unknown>;
  diskForecast?: () => Promise<unknown>;
  gmailArchivePlanLatest?: (input: FleetGmailArchivePlanLatestArgs) => Promise<unknown>;
  commsInbox?: (input: FleetCommsInboxArgs) => Promise<unknown>;
  commsReadiness?: () => Promise<unknown>;
  commsStatus?: () => Promise<unknown>;
  commsThread?: (input: FleetCommsThreadArgs) => Promise<unknown>;
  ownerHistory?: (input: FleetOwnerHistoryArgs) => Promise<unknown>;
  commsHealth?: () => Promise<unknown>;
  imessagePath?: () => Promise<unknown>;
  imessageAcks?: (input: FleetImessageAcksArgs) => Promise<unknown>;
  imessageTasks?: (input: FleetImessageTasksArgs) => Promise<unknown>;
  slackEvidence?: (input: FleetSlackEvidenceArgs) => Promise<unknown>;
  ciResumeInputs?: (input: FleetCiResumeInputsArgs) => Promise<unknown>;
  ciReceiptAwait?: (input: FleetCiReceiptAwaitArgs, signal: AbortSignal) => Promise<unknown>;
  ciReceiptAwaitBatch?: (input: FleetCiReceiptAwaitBatchArgs, signal: AbortSignal) => Promise<unknown>;
  releaseCandidate?: (input: FleetReleaseCandidateArgs) => Promise<unknown>;
  orchestrationRead?: (input: FleetOrchestrationReadArgs) => Promise<unknown>;
  intentRead?: (input: FleetIntentReadArgs) => Promise<unknown>;
  recheck?: () => Promise<unknown>;
  recheckHistory?: (input: FleetRecheckHistoryArgs) => Promise<unknown>;
  bridgeCheck?: () => Promise<unknown>;
}

/** SDK transport injection permits a real protocol round trip without a child. */
export function createFleetServer(readers: FleetReaders = { status: readFleetStatus, loop: readFleetLoop, bus: readFleetBusHops, busInbox: readFleetBusInbox }): Server {
  // The standalone binary embeds the version; npm/source installs have a
  // package.json. Do not import the mutation-capable gateway just for metadata.
  let version = process.env.ASHLR_VERSION;
  if (!version) {
    try { version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version; }
    catch { /* standalone distributions may not contain a package.json */ }
  }
  const server = new Server({ name: 'phantom-fleet', version: version || '0.0.0-unknown' }, {
    capabilities: { tools: {} },
    instructions: 'Read-only local persisted fleet observations. No tool starts, advances, pauses, or repairs the loop. Unknown or degraded evidence grants no execution authority.',
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    {
      name: 'fleet_staging_inventory',
      description: 'Inventory the local release-staging directory: children (name, modifiedAt, bytes), total measured bytes, completeness flags, skipped symlink count, and an age-and-size disclaimer. The tool *only* reports measured size; measurement does not grant permission to clean, reclaim, or unblock any launch. Root is the fixed ~/.local/share/ashlr/release-staging path — no arbitrary root or command parameter is accepted.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_staging_inventory_retry',
      description: 'Retry incomplete roots in a staging batch report. Age and size do not establish cleanup eligibility. Does not delete or propose deletion.',
      inputSchema: { type: 'object', properties: { report: { type: 'object' } }, required: ['report'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_staging_inventory_batch',
      description: 'Inventory 1 to 8 explicit staging roots sequentially. Age and size do not establish cleanup eligibility. Does not delete or propose approval to delete.',
      inputSchema: { type: 'object', properties: { roots: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } } }, required: ['roots'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_status',
      description: 'Read persisted fleet daemon liveness, budget, stop controls, backend quota, cached queue and proposal counts. Local-only subset of phm fleet status; no provider probes. Null means unknown, not zero.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_empties',
      description: 'Classify EMPTY finishes from the local job metrics and explicitly named result notes, with the empty rate and top five wasted-launch families. Same report as phm fleet empties. No caller paths or writes.',
      inputSchema: { type: 'object', properties: { hours: { type: 'number', exclusiveMinimum: 0, maximum: 2160, default: 24 } }, additionalProperties: false },
      annotations,
    },

    {
      name: 'fleet_loop',
      description: 'Observe loop liveness, current activity, stop controls, budget and recent tick history (oldest first). Never runs a tick. Reads remain available while KILL is engaged.',
      inputSchema: {
        type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_TICKS, default: 20 } },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_bus_hops',
      description: 'Observe the newest validated cross-agent bus hop metadata (message id, from/to, nullable token usage) in the local hop log, oldest first. A hop is only a recorded send attempt: no bodies, no delivery or lifecycle claims. `from`/`to`/`excludeFrom` narrow sender and recipient routing labels through the same identity-label matching fleet_bus_inbox applies — a ref naming one registered identity matches every label it answers to, an unresolvable ref or unreadable registry keeps exact-label matching, and excludeFrom drops one sender identity so it composes with `from` — while `id` keeps only the hop whose message id is strictly equal. The hop log carries no timestamps, so there is no time filter; position in append order is the only ordering the store proves. `matched` reports the filter-matching count inside the bounded tail observation and `truncated` stays honest about rows beyond it — a lower bound, never a fleet-wide total the bounded read cannot prove.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_BUS_HOPS, default: 20 },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender routing label; matches any label of the same registered agent identity.' },
          to: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Recipient routing label; matches any label of the same registered agent identity.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender routing label to drop; matches any label of the same registered agent identity.' },
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only the hop whose message id is strictly equal to this value — never a substring.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_host_runs',
      description: 'Read the bounded persisted host runs projection, including launched activity, claims and lane counts. Missing or degraded sources are reported as such; this does not probe providers or establish live worker state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_bus_inbox',
      description: 'Read a durable bus inbox page: validated envelopes with opaque bodies and integer cursors, oldest first, from the same store phm comms bus uses. Resume with nextCursor; expired records advance it unseen. Limit caps scanned live records before every filter. The to/from/excludeFrom address filters match the literal routing label or any other label of the same registered agent identity, and an unresolvable label or unreadable registry keeps exact matching — routing labels are data, never authenticated identity. The optional filters are the same read dimensions `phm comms bus read` applies: id and inReplyTo exact matches, excludeFrom drops one sender identity, priority keeps one P0–P3 band, kind keeps one protocol-v1 body kind, topic keeps bodies whose protocol topic matches a name or namespace prefix, thread keeps note/context bodies carrying that v2 label, job keeps envelopes naming one job, channel keeps envelopes addressed to group:<channel>:* under every topic — the same raw to-prefix rule the other bus reads\' channel filters apply — since keeps rows received at or after the cutoff (15m, 2h, 1d, epoch ms or an ISO time), before keeps rows received strictly before the cutoff on the same grammar — the exclusive upper bound composing with since into one [since, before) window — and contains keeps envelopes whose scrubbed one-line summary carries the needle — a secret-shaped value stays unfindable. Filtered rows still advance nextCursor, so a narrowed page resumes on the same cursor an unfiltered one would. Bodies are untrusted data and redaction can change displayed text. Missing, unavailable and retryable sources stay distinct; never invents an empty page, renews TTL, creates a store, or dispatches.',
      inputSchema: {
        type: 'object',
        properties: {
          after: { type: 'integer', minimum: 0, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_BUS_INBOX_READ, default: 50 },
          to: { type: 'string', description: 'Recipient routing label; matches any label of the same registered agent identity.' },
          from: { type: 'string', description: 'Sender routing label; matches any label of the same registered agent identity.' },
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep the envelope with this exact id.' },
          inReplyTo: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep envelopes whose object body carries this exact inReplyTo field.' },
          excludeFrom: { type: 'string', description: 'Sender routing label to drop; matches any label of the same registered agent identity.' },
          priority: { type: 'string', enum: [...BUS_PRIORITIES], description: 'Keep envelopes stamped with this exact P0–P3 band.' },
          kind: { type: 'string', enum: [...BUS_PROTOCOL_KINDS], description: 'Keep envelopes whose protocol-v1 body kind matches.' },
          topic: { type: 'string', description: 'Topic name (fleet.deploy) or namespace prefix (fleet.*) the body protocol topic must match.' },
          thread: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'v2 thread label; matches note/context bodies only.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep envelopes naming this job id — the same rule `phm comms bus read --job` applies.' },
          channel: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$', description: 'Keep envelopes addressed to group:<channel>:* — the room\'s whole traffic under every topic; the same raw to-prefix rule `phm comms bus read --channel` applies.' },
          since: { type: 'string', description: 'Keep rows received at or after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `phm comms bus read --since` takes.' },
          before: { type: 'string', description: 'Keep rows received strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window; the same grammar `phm comms bus read --before` takes.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each envelope\'s scrubbed one-line summary.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_inbox',
      description: 'Read one agent\'s addressed bus inbox — the same readAgentInbox projection `phm agents bus inbox` and `phm agents bus work mine`\'s inbox section serve, where fleet_bus_inbox only pages the raw durable store by routing label. `agent` is required and takes any ref resolveAgent accepts — a handle, agent:<handle>, stable agt_ id or alias — resolved through the server-owned registry; an unregistered ref answers unknown-agent, never a guessed match. Each row reports its delivery kind (dm, channel, handoff or legacy), the resolved sender handle or null, and for claimable work and worker-handoff bodies the live held/holder evidence — null when a hold store cannot be read, never proven free — plus, on bodies naming a job, the live work-feed state of that job, so pending mail shows where its job stands without a lookup per message. thread keeps note/context bodies carrying that v2 label; from and excludeFrom narrow senders through the same identity-label matching — an unresolvable ref keeps exact-label matching and the two compose so a sender both included and excluded matches nothing; priority keeps one P0–P3 band; kind keeps one delivery kind; job keeps mail naming one job (a work.post/status/result or wake jobId, a worker-handoff taskId, or a job:<id> thread label); since keeps mail received at or after the cutoff (15m, 2h, 1d, epoch ms or an ISO time); before keeps mail received strictly before its own cutoff on the same grammar — the exclusive upper bound composing with `since` into one [since, before) window on receivedAt; channel keeps mail addressed to group:<name>:* of one registry channel the agent belongs to; contains keeps mail whose scrubbed one-line summary carries the needle as a case-insensitive substring; inReplyTo keeps only mail whose object body cites that envelope id through its own inReplyTo field — the shared own-property exact match `phm agents bus inbox --in-reply-to`, `phm messages --in-reply-to`, `comms bus read|watch --in-reply-to`, `fleet bus-follow --in-reply-to` and `fleet_bus_inbox`\'s inReplyTo apply, never the replyTo alias or a substring, so "which of my pending mail answers envelope X" is one filtered read; `id` keeps only the mail whose own wire id is strictly equal to the value — the same exact-envelope match `phm agents bus inbox --id`, `comms bus read|watch --id`, `fleet bus-follow --id` and `fleet_bus_inbox`\'s `id` apply, never a substring or a body citation, so "is envelope X still pending for me" is one filtered read; `bodyKind` keeps only mail whose body carries that exact kind discriminator — the v2 `kind` field, a `worker-handoff` assignment, a notice kind, a bus-transport v1 `protocol.kind` or a `type`/`schema` notice discriminator, the same discriminator the row summary switches on — matched exactly and case-sensitively, so "which of my pending mail are work results" or "which are wake requests" is one filtered read, a body carrying no discriminator never matching. after resumes at a persisted cursor and limit caps returned rows (1–100, default 50); matched additionally reports the true filtered total across the whole retained store while messages still caps at limit, and nextCursor is the honest resume point — under matched it is the newest shown row\'s cursor, never the store\'s end, so resuming never skips an unshown match. Read-only: routing labels are data, never authenticated identity; a missing or unreadable store, registry or hold table stays unavailable or retryable and held/job stay unknown, never an invented empty inbox; no caller root, path or cwd is accepted, and the tool never claims, acks, replies, posts or renews TTL.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Agent ref — handle, agent:<handle>, stable agt_ id or alias — resolved through the server-side registry.' },
          after: { type: 'integer', minimum: 0, default: 0, description: 'Persisted cursor; rows at or below it are already handled.' },
          limit: { type: 'integer', minimum: 1, maximum: FLEET_AGENT_INBOX_LIMIT_MAX, default: FLEET_AGENT_INBOX_LIMIT_DEFAULT, description: 'Cap on returned rows after filtering.' },
          matched: { type: 'boolean', description: 'Also report matched — the true filtered total across the whole retained store.' },
          thread: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'v2 thread label; matches note/context bodies only.' },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref; matches every label of one registered identity, exact-label fallback when unresolvable.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref to drop under every label of one registered identity.' },
          priority: { type: 'string', enum: [...BUS_PRIORITIES], description: 'Keep mail stamped with this exact P0–P3 band.' },
          kind: { type: 'string', enum: [...INBOX_KINDS], description: 'Keep only this delivery kind — dm, channel, handoff or legacy.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep mail naming this job id — the same rule `phm agents bus inbox --job` applies.' },
          since: { type: 'string', description: 'Keep mail received at or after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `phm agents bus inbox --since` takes.' },
          before: { type: 'string', description: 'Keep mail received strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window, the same grammar `phm agents bus inbox --before` takes.' },
          channel: { type: 'string', description: 'Keep mail addressed to group:<name>:* of this registry channel the agent belongs to.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each row\'s scrubbed one-line summary.' },
          inReplyTo: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only mail whose object body cites this envelope id through its own inReplyTo field — the same own-property exact match `phm agents bus inbox --in-reply-to` and the raw bus reads apply.' },
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only mail whose own wire id is strictly equal to this value — the same exact-envelope match `phm agents bus inbox --id`, `comms bus read|watch --id`, `fleet bus-follow --id` and `fleet_bus_inbox`\'s `id` apply, never a substring or a body citation.' },
          bodyKind: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only mail whose body carries this exact kind discriminator — the v2 kind field, a worker-handoff assignment, a notice kind, a v1 protocol.kind or a type/schema notice discriminator — the same discriminator `phm agents bus inbox --body-kind` matches.' },
        },
        required: ['agent'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_work',
      description: 'Read one agent\'s pending-work digest — the same readBusWorkMineWithSeats projection `phm agents bus work mine` serves, where fleet_agent_inbox answers only the addressed-mail slice and fleet_work_feed only the job list. The digest joins every pending surface for the agent in one read: live claims it holds under any of its labels (message-id claims resolved to the retained envelope they lease, each joined to the feed jobs its declared keys block), open and announced work-feed jobs with per-key hold coverage — each blocked key\'s shown holders (owner label, lease expiry, claim class) named inline, so a live worker reads differently from a stale lease without a claim list read — claimable work envelopes and worker-handoff assignments in bus-next order, the conversation threads waiting on its answer, its own unanswered asks, blocked threads it is a party to, wake hints, the next inbox page, legacy `phm bus` mailbox mail, the shared task board digest, its registry channels and its bot-seat handoff records — each section reporting its own read state, so one unreadable store degrades only its own section and unknown stays unknown, never an empty list passed off as fact. `agent` is required — a handle, agent:<handle>, stable agt_ id or alias resolved through the server-owned registry; an unregistered ref resolves to no identity — agent.handle and agent.identity stay null and every section falls back to exact-label matching under the typed ref, never a guessed match. `job` keeps only pending work provably naming that job id; `since` keeps only pending items whose recorded time reaches the cutoff (15m, 2h, 1d, epoch ms or an ISO time); `before` keeps only pending items whose recorded time is strictly before its own cutoff on the same grammar — the exclusive upper bound composing with `since` into one [since, before) window on the sections whose stores keep a boundable timestamp — the inbox section applying it on receivedAt and the wakes section on the hint\'s queue time inside its own read, whose strictly-after `since` makes the wakes window (since, before) — while channels and seats carry no per-item historical timestamp and stay unfiltered; `contains` keeps only rows whose scrubbed display text carries the needle as a case-insensitive substring; `priority` keeps only pending items stamped with that exact P0–P3 band on the sections whose items carry a wire band — claims keep only message claims whose resolved leased envelope reports it — while feed jobs, announced jobs, thread sections, board rows, channels and seats carry no per-item band and stay unfiltered; `channel` keeps only pending items provably addressed to `group:<name>:*` of one bus channel under the strict channel-name grammar — the same room prefix every bus `--channel` read matches — on the sections whose items carry an address, while board rows, channels and seats carry no per-item room and stay unfiltered; `from` keeps only pending items provably sent by the named agent ref under the same identity-label matching every bus `--from` read applies — feed jobs and announced jobs keep announcements whose owner resolves to the ref, next/handoffs/mailbox keep envelopes whose from matches, claims keep only message claims whose resolved leased envelope\'s from matches, the thread sections pass the ref into the shared conversations read\'s own from filter, wakes and inbox pass it to their own reads\' sender filters, and board deliveries keep only posts whose sender label matches while board tasks — which record no author — never match, with seats and channels carrying no per-record sender and staying unfiltered; `excludeFrom` inverts the same match — a section keeps an item unless its sender evidence resolves to the excluded ref, so board tasks stay listed under it and a sender both included and excluded matches nothing — the same filters the `phm agents bus work mine` flags share, echoed back in the result. Read-only: routing labels are data, never authenticated identity; claims coordinate scope and grant no execution, claim, merge, push, spend or dispatch authority; a missing or unreadable store, registry, hold table, mailbox, board, wake queue or seat file stays unavailable or unknown inside its own section, never an invented empty digest; no caller root, path or cwd is accepted, and the tool never claims, acks, replies, posts, releases or writes.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Agent ref — handle, agent:<handle>, stable agt_ id or alias — resolved through the server-side registry.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only pending work provably naming this job id — the same rule `phm agents bus work mine --job` applies.' },
          since: { type: 'string', description: 'Keep only pending items whose recorded time reaches the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `phm agents bus work mine --since` takes.' },
          before: { type: 'string', description: 'Keep only pending items whose recorded time is strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window (the wakes section\'s own window is (since, before), its since strictly-after), the same grammar `phm agents bus work mine --before` takes.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each row\'s scrubbed display text.' },
          priority: { type: 'string', enum: [...BUS_PRIORITIES], description: 'Keep only pending items stamped with this exact P0–P3 band on the sections whose items carry a wire band — the same match `phm agents bus work mine --priority` applies.' },
          channel: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$', description: 'Keep only pending items provably addressed to group:<name>:* of this bus channel — the same room prefix `phm agents bus work mine --channel` applies.' },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only pending items provably sent by this agent ref — the same sender rule `phm agents bus work mine --from` applies.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only pending items NOT provably sent by this agent ref — the inverted `phm agents bus work mine --exclude-from` rule.' },
        },
        required: ['agent'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_wakes',
      description: 'Read wake hints — the same readAgentWakes/readAllWakes projections `phm agents bus wakes [--all]` serves, where fleet_agent_work\'s digest carries only a capped newest slice of the queue tail. `agent` is optional: supplied as a handle, agent:<handle>, stable agt_ id or alias it resolves through the server-owned registry and the read is that identity\'s queue — a ref that resolves to no identity but matches the printable-label rule keeps literal-to matching under scope \'label\', the same fallback the CLI read reports; omitted, the read is fleet-wide — every hint in the bounded queue tail across all addressees, registered identities\' and bare coordination/routing labels\' alike, each row\'s own `to` naming its addressee, reported under scope \'fleet\', the same read `phm agents bus wakes --all` serves, so a leader or comms pass sees who has pending hints in one read instead of one call per identity. Wake hints are the bus\'s notification layer: every bus.send hint resolves the live message it refers to — summary, priority, sender handle, channel, and for claimable work or a job citation the live held/holder plus job feed-state evidence — and every wh-… claim-holder hint re-derives the terminal work.status receipt that woke the holder, so "what should I look at" and "which wake was about X" are one filtered read without shelling out to `phm`. `since` keeps hints recorded strictly after the cutoff (15m, 2h, 1d, epoch ms or an ISO time — the wakes read\'s own boundary); `before` keeps hints recorded strictly before its own cutoff on the same grammar — the exclusive upper bound composing with `since` into the wakes read\'s own (since, before) window on queue time; `job` keeps hints provably naming one job id; `from`/`excludeFrom` narrow hint senders through the same identity-label matching — an unresolvable ref keeps exact-label matching and the two compose so a sender both included and excluded matches nothing; `channel` keeps only hints addressed to `group:<name>:*` of one channel under the strict channel-name grammar — the same room prefix `phm agents bus wakes --channel` and every other bus read\'s channel filter match, decided on the hint\'s own `to` label so it needs no referent resolution and composes with the addressee scope and every other filter; `priority` keeps hints in one exact P0–P3 band, decided on the resolved referent — the live message a bus.send hint points at or the citing work.status receipt behind a claim-holder wh-… hint, with unresolved or unknown referents never matching; `contains` keeps hints whose resolved referent text carries the needle as a case-insensitive substring; `id` keeps only the hint whose own id is strictly equal to the value — the triggering envelope\'s wire id on a bus.send hint, the wh-… claim-holder id on those — the same exact-id match `phm agents bus wakes --id` applies, decided on the queue row alone inside the queue-tail match so it counts in matched and needs no referent resolution; `thread` keeps only hints whose resolved referent is a note/context body carrying that v2 thread label and `inReplyTo` keeps only hints whose resolved referent body cites that envelope id through its own inReplyTo field — the same own-field matches `phm agents bus wakes --thread`/`--in-reply-to` and the inbox/channel reads apply, decided on the resolved referent so claim-holder wh-… hints and unresolved or unknown referents never match, with an unreadable bus store answering unavailable and matched counting the proven matches on the resolved page; `bodyKind` keeps only hints whose resolved referent body carries that exact kind discriminator — the same `busBodyKind` match `phm agents bus wakes --body-kind` and the inbox/channel reads\' `bodyKind` apply, where a resolved claim-holder wh-… hint\'s citing work.status receipt provably carries work.status so those hints match only that kind, with unresolved or unknown referents never matching under the same unreadable-store/matched rules. The page always reports matched — every hint the bounded queue tail accepted before its row cap — and truncated when the queue tail or cap cut matches beyond the shown slice, so a capped list is never passed off as the whole queue. Read-only: routing labels are data, never authenticated identity; a wake is a hint to read the inbox and grants no authority; a missing or unreadable store, registry, hold table or wake queue stays unavailable or unknown and referent/held/job evidence degrades to unknown, never an invented empty page or proven-free work; no caller root, path or cwd is accepted, and the tool never claims, acks, replies, posts or renews TTL.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Agent ref — handle, agent:<handle>, stable agt_ id or alias — resolved through the server-side registry; an unresolvable printable ref keeps literal-to matching under scope \'label\'. Omit for the fleet-wide read — every hint in the bounded queue tail under scope \'fleet\', the same read `phm agents bus wakes --all` serves.' },
          since: { type: 'string', description: 'Keep hints recorded strictly after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `phm agents bus wakes --since` takes.' },
          before: { type: 'string', description: 'Keep hints recorded strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into the wakes read\'s own (since, before) window, the same grammar `phm agents bus wakes --before` takes.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep hints provably naming this job id — the same rule `phm agents bus wakes --job` applies.' },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref; matches every label of one registered identity, exact-label fallback when unresolvable.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref to drop under every label of one registered identity.' },
          channel: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$', description: 'Keep only hints addressed to group:<name>:* of this channel — the same room prefix `phm agents bus wakes --channel` applies.' },
          priority: { type: 'string', enum: [...BUS_PRIORITIES], description: 'Keep hints in one exact P0–P3 band, decided on the resolved referent — the same match `phm agents bus wakes --priority` applies.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each hint\'s resolved referent text.' },
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only the hint whose own id is strictly equal to this value — the triggering envelope\'s wire id on a bus.send hint, the wh-… claim-holder id on those — the same exact-id match `phm agents bus wakes --id` applies.' },
          thread: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only hints whose resolved referent is a note/context body carrying this v2 thread label — the same match `phm agents bus wakes --thread` applies.' },
          inReplyTo: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only hints whose resolved referent body cites this envelope id through its own inReplyTo field — the same own-property exact match `phm agents bus wakes --in-reply-to` applies.' },
          bodyKind: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only hints whose resolved referent body carries this exact kind discriminator — the same `busBodyKind` match `phm agents bus wakes --body-kind` applies; a resolved claim-holder hint\'s citing work.status receipt matches only `work.status`.' },
        },
        required: [],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_messages',
      description: 'Read the fleet-wide agent-to-agent message timeline — the same readAgentMessages projection `phm messages`, GET /api/verse/agent-bus/messages and the desktop Messages/Org panes serve, where fleet_agent_inbox answers one agent\'s addressed mail, fleet_bus_channel one room\'s transcript and fleet_bus_inbox the raw store page — none lists every classified agent-to-agent message newest-first with its conversation, job and pr links in one read. Every argument is optional and takes the same value rules the `phm messages` flags and API params share: `since` keeps messages received at or after the cutoff (15m, 2h, 1d, epoch ms or an ISO time); `before` keeps messages received strictly before its own cutoff on the same grammar — the exclusive upper bound composing with `since` into one [since, before) window, the same rule every other bus read\'s `--before` applies; `agent` keeps the traffic one agent sent or received, matching through the server-side identity registry with exact-label fallback when a ref resolves to nothing; `with` narrows `agent` to the two-way talk between that agent and one other and requires `agent`; `kind` keeps one classified kind (ask, reply, handoff, status, blocker); `priority` keeps one exact P0–P3 band; `job` keeps the traffic that names one job — a row\'s job link, a live jobState citation or membership in the job:<id> conversation bucket; `thread` keeps only note/context bodies carrying that v2 thread label; `channel` keeps only envelopes addressed to group:<name>:* of one registry channel; `contains` keeps only messages whose scrubbed one-line summary carries the needle as a case-insensitive substring; `from` keeps only the messages one sender wrote — the same sender-inclusion match `phm messages --from`, `comms bus read|watch --from`, `agents bus inbox|channel read|wakes --from`, `fleet bus-follow --from` and `fleet_agent_inbox`\'s `from` apply, deciding on each row\'s sender only so rows merely addressed to that agent stay out; `excludeFrom` drops mail sent under every registered spelling of one identity; `inReplyTo` keeps only envelopes whose object body cites that envelope id through its own inReplyTo field — the shared own-property exact match `phm messages --in-reply-to`, `comms bus read|watch --in-reply-to`, `fleet bus-follow --in-reply-to`, `fleet_bus_inbox`\'s inReplyTo, `agents bus inbox --in-reply-to` and `agents bus channel read --in-reply-to` apply, never the replyTo alias or a substring, so "who answered envelope X" is one filtered read of the whole fleet timeline; `id` keeps only the envelope whose own wire id is strictly equal to the value — the same exact-envelope match `phm messages --id`, `comms bus read|watch --id`, `fleet bus-follow --id` and `fleet_bus_inbox`\'s `id` apply, never a substring, so "where did envelope X go" is one filtered read of the whole fleet timeline; `bodyKind` keeps only bodies whose own kind discriminator strictly equals the value — the same `busBodyKind` own-field exact match `phm messages --body-kind`, `agents bus inbox --body-kind`, `agents bus channel read --body-kind`, `agents bus wakes --body-kind` and `agents conversations --body-kind` apply, decided on the raw body before projection so a body carrying no discriminator never matches — an unrecognized but printable value is an honest empty page, never an error. `to` keeps only the envelopes addressed to that routing label — the same addressed-to rule `phm messages --to`, `comms bus read|watch --to` and `fleet_bus_inbox`\'s `to` apply through agentRefAddressMatcher, so a handle, agent: address, stable id or alias of one registered identity matches every label of that identity while an unresolvable ref keeps exact-label matching, decided on each row\'s raw to label; `limit` caps returned messages newest-first (1–1024, default 50); `matched` always reports the true filtered total before the cap, `skipped` counts damaged bus rows and `source` keeps missing/unavailable honest — an unreadable store is never an invented empty timeline. Each row reports id, ts, priority, classified kind, resolved from/to name and lane, scrubbed summary, conversation, job and pr links, and jobState feed evidence on bodies citing a job. Read-only: routing labels are data, never authenticated identity; no caller root, path or cwd is accepted, and the tool never posts, claims, acks, replies or renews TTL.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'Keep messages received at or after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `phm messages --since` takes.' },
          before: { type: 'string', description: 'Keep messages received strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window; the same grammar `phm messages --before` takes.' },
          agent: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Agent ref — handle, agent:<handle>, stable agt_ id or alias — resolved through the server-side registry; matches mail the agent sent or received.' },
          with: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'The other agent in a two-way talk; requires `agent` — the same rule `phm messages --with` applies.' },
          kind: { type: 'string', enum: [...AGENT_MESSAGE_KINDS], description: 'Keep only this classified kind — ask, reply, handoff, status or blocker.' },
          priority: { type: 'string', enum: [...BUS_PRIORITIES], description: 'Keep only messages stamped with this exact P0–P3 band.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep the traffic that names this job id — the same rule `phm messages --job` applies.' },
          thread: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'v2 thread label; matches note/context bodies only — the same rule `phm messages --thread` applies.' },
          channel: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$', description: 'Keep only envelopes addressed to group:<name>:* of this registry channel — the room\'s whole traffic under every topic.' },
          contains: { type: 'string', minLength: 1, maxLength: AGENT_MESSAGES_CONTAINS_MAX, description: 'Case-insensitive substring over each message\'s scrubbed one-line summary.' },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref to keep under every label of one registered identity — the sender-inclusion counterpart of excludeFrom.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref to drop under every label of one registered identity.' },
          inReplyTo: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only envelopes whose object body cites this envelope id through its own inReplyTo field — the same own-property exact match `phm messages --in-reply-to` applies.' },
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only the envelope whose own wire id is strictly equal to this value — the same exact-envelope match `phm messages --id`, `comms bus read|watch --id`, `fleet bus-follow --id` and `fleet_bus_inbox`\'s `id` apply, never a substring.' },
          bodyKind: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only bodies whose own kind discriminator strictly equals this value — the same `busBodyKind` own-field exact match `phm messages --body-kind` and the other bus reads\' body-kind filter apply; a body carrying no discriminator never matches.' },
          to: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only envelopes addressed to this routing label — a handle, agent: address, stable id or alias of one registered identity matches every label of that identity; an unresolvable ref keeps exact-label matching — the same addressed-to rule `phm messages --to`, `comms bus read|watch --to` and `fleet_bus_inbox`\'s `to` apply.' },
          limit: { type: 'integer', minimum: 1, maximum: AGENT_MESSAGES_MAX_LIMIT, default: AGENT_MESSAGES_DEFAULT_LIMIT, description: 'Cap on returned messages, newest first.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_channels',
      description: 'Read the agent-bus channel roster — the same listBusChannels projection `phm agents bus channel list [--agent]` serves, where fleet_bus_channel reads one room\'s transcript, fleet_agent_work reports the channels one agent belongs to inside its digest and fleet_agent_messages narrows traffic to one channel\'s group:<name>:* traffic — none answers "which channels exist and who is in them" fleet-wide, the directory an agent needs before posting to a room or picking a channel-scoped `to` address, without shelling out to `phm`. `agent` is optional — a handle, agent:<handle>, stable agt_ id or alias resolved through the server-owned registry; it narrows the roster to the channels that identity belongs to, and a ref that resolves to no identity answers unknown-agent, never a guessed membership. Every channel reports its name, creator, creation time and member handles in join order; members are routing labels that say who may post — not presence, attention or authority. Read-only: no caller root, path or cwd is accepted, and the tool never posts, joins, leaves or renames a channel; source missing is a verified-empty roster while an unreadable registry stays unavailable — never an invented empty list.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Agent ref — handle, agent:<handle>, stable agt_ id or alias — resolved through the server-side registry; narrows the roster to the channels the identity belongs to. Omit for the fleet-wide roster.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_identity',
      description: 'Resolve one agent ref to its bus identity card — the same busAgentView projection `phm agents bus id show <ref>` serves, where every other bus read resolves refs through the server-owned registry but none answers "what is this ref" in one call: fleet_agent_inbox, fleet_agent_work, fleet_agent_wakes, fleet_agent_messages, fleet_agent_channels and fleet_agent_conversations each consume a resolved identity inside their own slice, and fleet_bus_status reports the registry\'s health, but an agent that sees a from/to/owner label in a message row, claim owner or channel member list has no read that turns it into the canonical agt_ id, handle, display name, aliases and runtimes — plus the agent:<handle> address mail to it carries and the registry channels whose member list names its handle — without shelling out to `phm`. `agent` is required — a handle, agent:<handle>, stable agt_ id or alias under the printable-label rule every bus read shares — because the shared fleet server has no per-caller PHM_AGENT_ID, so the no-ref self view `agents bus id show` serves would answer for the server, never the caller. A ref that resolves to no identity answers unknown — on a missing registry that is every ref, the same verified-empty verdict the CLI read reports — a malformed one invalid and an unreadable registry unavailable, never a guessed match. Read-only: no caller root, path or cwd is accepted — the registry root stays server-owned — and the tool never registers, aliases, joins channels or writes; an identity is a routing name and the labels it answers to, never authentication, presence or authority.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Agent ref — handle, agent:<handle>, stable agt_ id or alias — resolved through the server-side registry; the card answers for exactly this ref.' },
        },
        required: ['agent'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_conversations',
      description: 'Read the shared agent-to-agent conversation threads — the same readAgentConversations projection `phm agents conversations` and GET /api/verse/fleet/control/agent-conversations serve, where fleet_agent_messages lists the flat newest-first timeline, fleet_agent_inbox answers one agent\'s addressed mail and fleet_agent_work carries one agent\'s pending digest — none answers the grouped question "which threads are agents waiting on each other in, who owes whom a reply, which thread is blocked or done, and what moved lately" in one read. Every argument is optional and takes the same value rules the CLI flags and API params share: `agent` keeps the threads one identity is in (handle, agent:<handle>, stable agt_ id or alias resolved through the server-owned registry); `job` keeps the threads that name one job — its job:<id> bucket or a member message citing it; `waitingOn` keeps the waiting threads one agent owes a reply on — its own labels or a group:<channel>:<topic> address of a channel it belongs to, never a thread whose waiting message the agent itself sent; `waiting`/`blocked` are JSON booleans for the --waiting/--blocked shortcuts (false is the same as absent); `state` keeps threads in one of waiting/answered/blocked/done — the general form of the two booleans, which stay conjunctive with it so a contradictory pair is an honest empty list; `since` keeps threads whose last activity reaches the cutoff (15m, 2h, 1d, epoch ms or an ISO time — whole threads, never partial message lists); `before` keeps threads whose last activity is strictly before its own cutoff on the same grammar — the exclusive upper bound composing with `since` into one [since, before) window; `contains` keeps threads where at least one member message\'s scrubbed one-line subject carries the needle as a case-insensitive substring — never the raw body; `inReplyTo` keeps threads where at least one member message\'s body cites that envelope id through its own inReplyTo field — the same own-property exact match every bus read\'s --in-reply-to applies, never the replyTo alias or a substring; `id` keeps only the thread one member message\'s own wire id strictly equals — at most one thread, since every member message sits in exactly one — the same exact-envelope match every other bus read\'s --id applies (`phm messages --id`, `agents bus inbox`/`channel read --id`, `agents bus wakes --id`, `comms bus read|watch --id`, `fleet bus-follow --id` and `fleet_bus_inbox`\'s `id`), never a substring or a thread-key or body citation — so "which thread is envelope X in" is one filtered read returning the whole thread where `phm messages --id` reports only the row; `channel` keeps threads where at least one member message is addressed to group:<channel>:* — the room\'s traffic under every topic, the same raw address prefix every bus read\'s --channel matches; `priority` keeps threads where at least one member message carries that exact P0..P3 band; `from` keeps threads where at least one member message was sent under that agent\'s labels and `excludeFrom` drops threads where any member message was sent under that agent\'s labels — the same sender rules every bus read\'s --from/--exclude-from apply; `with` narrows `agent` to the threads holding the two-way exchange between the two named agents — the same pairwise rule `phm messages --agent <a> --with <b>` applies, decided on each member message\'s from/to endpoints in either direction — and means nothing without `agent`, refused the same way the CLI flag is; `thread` keeps only the threads where at least one member message declared that exact conversation bucket — a thread label, threadId, job:<id> or origin key, strictly equal, never a substring or a reply-chain root — the same own-field exact match every bus read\'s --thread applies, so an undeclared chain names no provable thread and never matches; `bodyKind` keeps only the threads where at least one member message\'s body carries that exact kind discriminator — the same busBodyKind own-field exact match every bus read\'s body-kind filter applies, a member body with no discriminator never matching; `limit` caps returned threads 1–1024, longest-waiting order kept. Each thread reports its participants, scrubbed subject, message count, last activity, state, waiting detail (on whom, for how long), job links, cross-links and member messages; `matched` reports every thread the filters kept before `limit`, `waiting` counts the unfiltered waiting threads, `skipped` counts damaged bus rows and `source` keeps missing/unavailable honest — an unreadable store or registry leaves conversations, matched and waiting null, never an invented empty list. Read-only: routing labels are data, never authenticated identity; no caller root, path or cwd is accepted — the store and registry roots stay server-owned — and the tool never posts, claims, acks, replies or writes.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Agent ref — handle, agent:<handle>, stable agt_ id or alias — resolved through the server-side registry; keeps the threads that identity is in.' },
          waiting: { type: 'boolean', description: 'Keep only threads waiting for a reply — the `phm agents conversations --waiting` / `?waiting=1` rule.' },
          blocked: { type: 'boolean', description: 'Keep only threads a blocker or failed report left unanswered — the `--blocked`/`?blocked=1` rule.' },
          state: { type: 'string', enum: [...CONVERSATION_STATES], description: 'Keep only threads in this one state — the general form of `waiting`/`blocked`, conjunctive with them.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only threads that name this job id — its job:<id> bucket or a member message citing it.' },
          waitingOn: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only the waiting threads this agent owes a reply on — its own labels or a channel address it belongs to, never a thread it is itself waiting on.' },
          since: { type: 'string', description: 'Keep threads whose last activity is at or after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `phm agents conversations --since` takes.' },
          before: { type: 'string', description: 'Keep threads whose last activity is strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window; the same grammar `phm agents conversations --before` takes.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each member message\'s scrubbed one-line subject.' },
          inReplyTo: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only threads where a member message\'s body cites this envelope id through its own inReplyTo field.' },
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only the thread one member message\'s own wire id strictly equals — at most one thread — the same exact-envelope match every bus read\'s --id applies.' },
          channel: { type: 'string', description: 'Keep only threads where a member message is addressed to group:<channel>:* — the strict channel-name grammar.' },
          priority: { type: 'string', enum: [...BUS_PRIORITIES], description: 'Keep only threads where a member message carries this exact P0..P3 band.' },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only threads where a member message was sent under this agent\'s labels.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Drop threads where any member message was sent under this agent\'s labels.' },
          with: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'The other agent in a two-way exchange; requires `agent` — the same rule `phm agents conversations --with` applies.' },
          thread: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only threads where a member message declared this exact conversation bucket — a thread label, threadId, job:<id> or origin key — the same `phm agents conversations --thread` rule.' },
          bodyKind: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only threads where a member message\'s body carries this exact kind discriminator — the same `phm agents conversations --body-kind` rule.' },
          limit: { type: 'integer', minimum: 1, maximum: 1024, description: 'Cap on returned threads, longest-waiting order kept; `matched` still reports the full filtered count.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_agent_roster',
      description: 'Read the unified live session roster — the same collectAgentRoster projection `phm agents roster` and the native `phm_agent_roster` tool serve, where every other fleet_agent_* read answers a question about the bus itself (fleet_agent_inbox addressed mail, fleet_agent_work the pending-work digest, fleet_agent_wakes wake hints, fleet_agent_messages the classified timeline, fleet_agent_channels the channel roster, fleet_agent_identity one card, fleet_agent_conversations the grouped threads) and fleet_bus_status reports the bus stores\' health — none answers the presence question an agent asks before it routes, hands off or waits: "which agent sessions are actually running right now, on which provider, and what is each holding." The roster probes nine sources in parallel — Phantom\'s own live workers, Devin cloud, the Devin Desktop/CLI roster file, Codex, Claude, Cursor, Grok, Ollama and oMLX — each bounded by a short timeout, then joins the live coordination leases every session\'s claims come from. Each source reports its own ok/availability/error: a probe that times out, is missing or returns an unrecognized shape degrades only its own source to unknown with its reason — never an invented empty or populated list — and the result keeps observedAt and latencyMs honest about when and how long the observation took. Session titles, ownership, urls and blockers are scrubbed of secrets and control characters inside the projection and every string is scrubbed again at serialization; fencing tokens never leave the claim store. Takes no arguments — every probe target, store root and clock stays server-owned and any argument is refused. Read-only: probes run fixed read-only argv with a sanitized environment, loopback fetches are restricted to the local Ollama/oMLX status endpoints, the Devin cloud leg is a read-only authenticated session list, and the tool never claims, posts, sends, launches, holds or writes; session ids, titles, urls, orgs and claim owners are routing and observation data — never authenticated identity, presence proof or execution authority; a throwing roster read reports status unavailable, never an invented roster; no caller root, path or cwd is accepted.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_bus_channel',
      description: 'Read one agent-bus channel transcript — the same readAgentChannel projection `phm agents bus channel read` serves, where fleet_bus_inbox only pages the raw durable store by routing label and fleet_agent_inbox answers one agent\'s addressed mail, never the room. `channel` is required — a registry channel name; a name no channel carries answers unknown-channel, never a guessed match, and reading needs no identity or membership: membership gates posting only. topic narrows to one group:<channel>:<topic> address; group.presence heartbeats never appear — they are expiring observations with their own read, not messages. from and excludeFrom narrow senders through the same identity-label matching — an unresolvable ref keeps exact-label matching and the two compose so a sender both included and excluded matches nothing; thread keeps note/context bodies carrying that v2 label; priority keeps one P0–P3 band; job keeps posts naming one job (a work.post/status/result or wake jobId, a worker-handoff taskId, or a job:<id> thread label); since keeps posts received at or after the cutoff (15m, 2h, 1d, epoch ms or an ISO time); before keeps posts received strictly before its own cutoff on the same grammar — the exclusive upper bound composing with `since` into one [since, before) window on receivedAt; contains keeps posts whose scrubbed one-line summary carries the needle as a case-insensitive substring; inReplyTo keeps only posts whose object body cites that envelope id through its own inReplyTo field — the shared own-property exact match `phm agents bus channel read --in-reply-to`, `phm agents bus inbox --in-reply-to`, `phm messages --in-reply-to` and the raw bus reads apply, never the replyTo alias or a substring, so "which room posts answer envelope X" is one filtered read; `id` keeps only the post whose own wire id is strictly equal to the value — the same exact-envelope match `phm agents bus channel read --id` and the raw bus reads\' `id` apply, never a substring or a body citation, so "did envelope X reach the room" is one filtered read of the transcript; `bodyKind` keeps only posts whose body carries that exact kind discriminator — the v2 `kind` field, a `worker-handoff` assignment, a notice kind, a bus-transport v1 `protocol.kind` or a `type`/`schema` notice discriminator, the same discriminator the row summary switches on — matched exactly and case-sensitively, so "which room posts are work results" or "which are wake requests" is one filtered read of the transcript, a body carrying no discriminator never matching. Each row reports its topic, the resolved sender handle or null, and for claimable work and worker-handoff bodies the live held/holder evidence — null when a hold store cannot be read, never proven free — plus, on bodies naming a job, the live work-feed state of that job. after resumes at a persisted cursor and limit caps returned rows (1–100, default 50); matched additionally reports the true filtered total across the whole retained store while messages still caps at limit, and nextCursor is the honest resume point — under matched it is the newest shown row\'s cursor, never the store\'s end, so resuming never skips an unshown match. Read-only: routing labels are data, never authenticated identity; a missing or unreadable store or registry stays unavailable or retryable and held/job stay unknown, never an invented empty transcript; no caller root, path or cwd is accepted, and the tool never posts, claims, acks or renews TTL.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$', description: 'Registry channel name — the group:<channel>:* room the transcript covers.' },
          topic: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$', description: 'Keep only posts addressed to group:<channel>:<topic>.' },
          after: { type: 'integer', minimum: 0, default: 0, description: 'Persisted cursor; rows at or below it are already handled.' },
          limit: { type: 'integer', minimum: 1, maximum: FLEET_BUS_CHANNEL_LIMIT_MAX, default: FLEET_BUS_CHANNEL_LIMIT_DEFAULT, description: 'Cap on returned rows after filtering.' },
          matched: { type: 'boolean', description: 'Also report matched — the true filtered total across the whole retained store.' },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref; matches every label of one registered identity, exact-label fallback when unresolvable.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref to drop under every label of one registered identity.' },
          thread: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'v2 thread label; matches note/context bodies only.' },
          priority: { type: 'string', enum: [...BUS_PRIORITIES], description: 'Keep posts stamped with this exact P0–P3 band.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep posts naming this job id — the same rule `phm agents bus channel read --job` applies.' },
          since: { type: 'string', description: 'Keep posts received at or after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `phm agents bus channel read --since` takes.' },
          before: { type: 'string', description: 'Keep posts received strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window, the same grammar `phm agents bus channel read --before` takes.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each post\'s scrubbed one-line summary.' },
          inReplyTo: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only posts whose object body cites this envelope id through its own inReplyTo field — the same own-property exact match `phm agents bus channel read --in-reply-to` and the raw bus reads apply.' },
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only the post whose own wire id is strictly equal to this value — the same exact-envelope match `phm agents bus channel read --id`, `comms bus read|watch --id`, `fleet bus-follow --id` and `fleet_bus_inbox`\'s `id` apply, never a substring or a body citation.' },
          bodyKind: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only posts whose body carries this exact kind discriminator — the v2 kind field, a worker-handoff assignment, a notice kind, a v1 protocol.kind or a type/schema notice discriminator — the same discriminator `phm agents bus channel read --body-kind` matches.' },
        },
        required: ['channel'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_bus_show',
      description: 'Resolve one retained bus envelope by wire id — the same readBusEnvelopeById projection `phm agents bus show <id>` serves, the citation resolver every other bus read points at: inbox rows, channel posts, work postId/statusId/result receipts, handoff ids and wake-hint statusId citations all name ids only this read resolves without shelling out to `phm`. `id` is required — an envelope wire id or a `wh-…` claim-holder wake-hint id, the same printable routing-label rule the CLI flag applies — and resolves through the server-owned store, registry, hold table, wake queue and feed roots. The ok result carries the live receipt (cursor, receivedAt, priority, resolved sender handle or null, full envelope), plus — on claimable work and worker-handoff bodies — the tri-state held/holder evidence (null when a hold store cannot be read, never proven free), and — on bodies naming a job — the live work-feed state of that job; a `wh-…` id resolves through the wake queue to the terminal work.status receipt that cites it with a wakeHint citation. not-found means the id is expired, reclaimed or never posted (a proven miss on a wh-… shape also reports not-found); invalid, unavailable and retryable keep their own status and reason — an unreadable store is never an invented miss. Read-only: routing labels are data, never authenticated identity; no caller root, path or cwd is accepted, and the tool never claims, acks, replies, posts or renews TTL.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Envelope wire id, or a wh-… claim-holder wake-hint id — the ids fleet_agent_inbox, fleet_agent_work, fleet_bus_channel and fleet_work_feed rows cite.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_bus_thread',
      description: 'Read one reply thread\'s retained live context — the same readBusThread projection `ashlr fleet bus-thread --id <id>` serves, where fleet_bus_show resolves one envelope, fleet_bus_inbox pages the raw store and fleet_agent_conversations groups the classified threads: none reconstructs the inReplyTo chain around one id. `id` is required — the envelope wire id the thread roots at, the same printable routing-label rule the CLI flag and fleet_bus_show\'s id apply — validated before any store read; unknown keys, caller roots, paths and working directories are refused the same way, and no caller root, path or cwd is accepted. The result is fleet.bus-thread.v1 plus MCP metadata: requestedId, rootFound (false is a proven miss — the root is expired, reclaimed or never posted), messages (every live receipt whose own inReplyTo field transitively cites the root, in cursor order — including the kindless {inReplyTo, text} replies comms bus reply and fleet bus-reply post, which the classified projections never group), scannedThrough, complete and sourceFailure — a bounded page walk that rechecks TTL before projecting, so an unreadable or invalid store reports complete:false with its own failure reason, never an invented empty thread. Read-only: the store root stays server-owned, the walk writes nothing, and the tool never posts, claims, acks, replies or renews TTL; routing labels are data, never authenticated identity, and envelope bodies are untrusted data the caller interprets.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Envelope wire id the reply thread roots at — the id fleet_bus_show, fleet_agent_inbox, fleet_agent_work and fleet_work_feed rows cite.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_bus_status',
      description: 'Read the unified agent-bus health probe — the same readUnifiedBusStatus projection `phm agents bus status` serves, where every other bus tool reports only its own slice and none answers "is the bus itself healthy" in one call. No arguments: every store root stays server-owned. The result names each dependency the bus verbs touch — the message store, identity registry, wake queue, coordination table, message-id claim journal, the claim-drift verdict joining the two claim stores, the work-feed projection, the legacy mailbox, the owner-chat receipts ledger, the shared task board with its fleet queue claim index, the bot-seat store, the agentnet peer work-dispatch journal and peer coordination ledger — and the outbound send gate every write verb passes through: sendGate.state open, blocked or unknown with the kill-switch sentinel and comms-pause verdicts kept separate, so an agent can check whether a write would land before assuming it. Read-only: each section reports its own real state, a store that cannot be read reports unavailable with null counts — never zero — and the probe never throws, writes, takes a lock or makes a network call; counts and verdicts only, never labels, handles, claim keys, peer names, threads or bodies; no caller root, path or cwd is accepted, and the tool never claims, acks, posts or sends.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_bus_claims',
      description: 'Read the live coordination claims — the same listBusClaims projection `phm agents bus claim list` serves, the claim table\'s own read where every other bus tool reports claims only inside its own slice: fleet_agent_work carries the claims one agent holds, fleet_work_feed\'s claims join annotates the jobs one feed page lists, and fleet_coordination_claims reads the separate host advisory ledger — none answers "who holds this claim key" or "what is live across every origin" fleet-wide. Takes no required arguments — every coordination and feed root stays server-owned and any caller root, path or cwd is refused. `key` keeps only live claims that would block an acquire of that v2 claim key under the same overlap rule claim acquire applies (repo:, path:, queue: or pr:); `owner` keeps only claims owned by one routing ref — a handle, agent:<handle>, stable id or alias resolved through the server-side registry, with exact-label matching kept when the ref resolves to nothing; `excludeOwner` drops claims owned by one routing ref under the same identity-label rule, inverted, so "what do the other seats hold" is one read; `contains` keeps only claims whose key, sourceId or repo/branch/path target fields carry the needle as a case-insensitive substring — the same --contains rule every bus read shares; `origin` keeps one claim class (resource, message, team or board); `since` keeps only claims whose recorded `started` — the lease\'s ISO acquisition time — is at or after the cutoff and `before` keeps only claims whose `started` is strictly before its own cutoff, the pair reading one [since, before) window under the same 15m, 2h, 1d, epoch ms or ISO grammar every bus read\'s time filters take — a claim whose origin keeps no start stamp never matches, the same "unknown stays out" rule `phm agents bus claim list --since|--before` applies; `jobs` additionally joins each claim with the announced feed jobs its keys block and reports the feed read state, so blocked work stays unknown rather than an empty list when the feed cannot be read. The result reports source missing (verified-empty), available or unavailable — an unreadable table is never an invented empty list — plus asOf, the resolved owner and excludeOwner matches and feed state. Read-only: claims coordinate scope and grant no execution, claim, merge, push, spend or dispatch authority; fencing tokens never leave the store; routing labels are data, never authenticated identity; and the tool never acquires, renews, releases or completes a claim.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'V2 claim key (repo:<owner/name>, path:<owner/name>:<glob>, queue:<id> or pr:<owner/name>#<n>) — keep only live claims that would block an acquire of it.' },
          owner: { type: 'string', pattern: '^[\\x21-\\x7e]{1,256}$', description: 'Owner routing ref; matches every label of one registered identity, exact-label fallback when unresolvable.' },
          excludeOwner: { type: 'string', pattern: '^[\\x21-\\x7e]{1,256}$', description: 'Drop claims owned by this routing ref — the same identity-label resolution owner applies, inverted; composes with owner.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each claim row\'s key, sourceId and repo/branch/path target fields — the same --contains rule every bus read shares.' },
          origin: { type: 'string', enum: [...COORDINATION_ORIGINS], description: 'Keep only live claims of this origin class.' },
          since: { type: 'string', description: 'Keep only claims whose recorded started — the lease\'s ISO acquisition time — is at or after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time, the same grammar `phm agents bus claim list --since` takes. A claim whose origin keeps no start stamp never matches.' },
          before: { type: 'string', description: 'Keep only claims whose recorded started is strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window, the same grammar `phm agents bus claim list --before` takes.' },
          jobs: { type: 'boolean', description: 'Join each claim with the announced feed jobs its keys block; feed reports the read state (ok, refused, unavailable, retryable or invalid).' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_bus_board',
      description: 'Read the shared task board\'s fleet-wide pending digest — the same readBusBoardPending/BusBoard.pendingAll read `phm comms inbox`\'s board source projects and `phm agents bus work mine`\'s board section narrows to one agent\'s labels, where fleet_agent_work needs the agent\'s labels ahead of time, fleet_comms_inbox flattens the digest into ranked items and fleet_work_board classifies durable bus requests — a different board entirely — so none answers "what is pending on the shared board, fleet-wide, for this job" in one call. `job` keeps only threads carrying a task whose fleet itemId cites that job — the same citation rule the work-mine board section applies, with `peers` then reporting only that job\'s thread members; `contains` keeps only rows whose scrubbed display text carries the needle as a case-insensitive substring — the same `--contains` rule every bus read shares; `since` (15m, 2h, 1d, epoch ms or ISO) keeps only deliveries whose createdAt reaches the cutoff and `before` keeps only deliveries recorded strictly before its own cutoff, the pair reading one [since, before) window — board tasks carry no timestamp, so under a time bound the task list is provably empty rather than padded with undated rows, and thread rollups list only while a surviving delivery remains. `from` and `excludeFrom` are the sender filters every bus read shares, resolved through the server-side identity registry under the same fleet root the board derives from: a handle, agent:<handle>, stable agt_ id or alias of one registered identity keeps or drops every delivery whose sender label belongs to that identity, an unresolvable ref or unreadable registry keeps exact-label matching — unknown identity state never widens the read — and the two compose include-then-exclude so a sender both included and excluded matches nothing; board tasks record no author, so under `from` they never match while under `excludeFrom` they stay listed — nothing proves a task came from the excluded sender. The result reports source missing (verified-empty — no state.json was ever written), available or unavailable — an unreadable board, malformed config, relative path override or disabled event bus is never an invented empty digest — plus the digest\'s peers, claims read state, thread rollups and the deliveries/tasks matched totals with 50-item caps and truncated flags; every task hold is open/held/ambiguous/unknown under the shared-queue claim index — unknown never proven open — and item content.text stays the stored untrusted text: canonical envelope JSON for deliveries, titles for tasks and threads. Read-only: the digest takes the board\'s local read lock but writes nothing and never acknowledges a delivery or claims a task; routing labels are data, never authenticated identity; claims coordinate scope and grant no execution, claim, merge, push, spend or dispatch authority; no caller root, path or cwd is accepted, and the tool never posts, acks, claims, hands off or releases.',
      inputSchema: {
        type: 'object',
        properties: {
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only threads carrying a task whose fleet itemId cites this job id — the same citation rule the work-mine board section applies.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_READ_CONTAINS_MAX, description: 'Case-insensitive substring over each row\'s scrubbed display text — delivery post text, task and thread titles — the same --contains rule every bus read shares.' },
          since: { type: 'string', description: 'Keep only deliveries whose createdAt reaches this cutoff: 15m, 2h, 1d, epoch ms or an ISO time. Board tasks carry no timestamp and never match under a time bound.' },
          before: { type: 'string', description: 'Keep only deliveries recorded strictly before this cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with since into one [since, before) window. Board tasks carry no timestamp and never match under a time bound.' },
          from: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref — handle, agent:<handle>, stable agt_ id or alias — keeping only deliveries whose sender label belongs to that registered identity; board tasks record no author and never match under it.' },
          excludeFrom: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Sender ref to drop under every label of one registered identity; board tasks stay listed — nothing proves a task came from the excluded sender.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_seat_handoffs',
      description: 'Read the fleet-wide bot-seat handoff plan — the same planSeatHandoffs projection `phm bots handoffs`, the unified inbox seats source and `phm agents bus work mine`\'s seats section share, where fleet_agent_work narrows it to one agent\'s seats and fleet_comms_inbox keeps only eligible seats with pending records as ranked inbox items. No arguments: every seat, fleet, runs and node root stays server-owned and any argument is refused. Every roster seat reports its config seatId, bus participantId, projected lifecycle state (active, draining or idle) and handoff eligibility under the same rule plan and apply enforce, plus its pending handoff records — the deterministic handoffIds `phm bots handoff --seat <id> --apply` dedupes on — for eligible seats only; ineligible seats report eligible false with no records. apply stays false: the read never releases work, writes journals or notices, takes no lock and persists no lifecycle transition — unlike `phm bots seats`, whose roster read does persist seat state. A throwing plan read reports status unavailable, never an invented empty roster; seat ids and participant ids are routing labels, never authenticated identities, and the plan grants no claim, release, dispatch or execution authority; no caller root, path or cwd is accepted.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_bot_seats',
      description: 'Read the bot-seat roster — the same readBotSeats projection `phm bots seats --json` serves minus its persist-on-read lifecycle write, where fleet_seat_handoffs reports only the handoff plan (seatId, participantId, state, eligible, pending records) and fleet_agent_work narrows that plan to one agent\'s seats, so no existing tool answers "which seats can accept new work right now" — per-seat quota evidence, projected lifecycle state, acceptsNewWork and open claims/jobs — in one call. Takes no arguments — every seat, fleet, runs and node root stays server-owned and any argument is refused. Every roster seat reports its config seatId, kind, displayName, capabilities, bus participantId and participant view, projected lifecycle state (active, draining or idle), acceptsNewWork (active state plus measured quota — the same admission seatMayClaim applies), live quota evidence (measured usedPct/resetAt/asOf/source, or unknown with its reason — never an invented zero), its live coordination claims, in-flight node jobs and recent handoff records; seat secret-handle names and adapter internals stay out of the result. persisted stays false: the read shares listSeats\' seat-view projection but never writes the lifecycle transition `phm bots seats` persists, takes no lock and releases, claims or sends nothing. A throwing roster read reports status unavailable, never an invented empty roster; seat ids, participant ids, claim keys and owners are routing labels, never authenticated identities, and the roster grants no claim, release, dispatch or execution authority; no caller root, path or cwd is accepted.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_work_feed',
      description: 'Read the bus v2 work feed — the same readBusWorkFeed + projectBusWorkFeedView projection `phm fleet work-feed`, `phm agents bus work feed` and GET /api/verse/agent-bus/work-feed serve. status, job, repo, provider, tier, to, owner, since, before, contains, channel and result narrow the job list under the same parseBusWorkFeedQuery rules the CLI flags and the HTTP endpoint share — since inclusive and before exclusive on the job\'s last activity, so the pair reads one [since, before) window and older pages stay reachable past the newest-first limit cap; channel keeps only jobs announced to group:<channel>:* — the room traffic under every topic, the same address prefix agents bus inbox --channel and channel read match; result keeps only jobs whose newest retained work.result citation carries that outcome — reported evidence that never moved the job\'s status, so a complete result on a still-running job is the divergence it surfaces, and a job with no result never matches; claims joins live coordination holds onto each job, and open/claimable keep open-status candidates — open and claimable imply the claims join. to matches jobs addressed to that agent — the literal routing label, every label of one agent identity, and group:<channel>:<topic> addresses of registry channels the identity belongs to, minus channel posts the identity sent itself — while owner keeps jobs announced by that agent under every label of one agent identity, all through the server-side registry with exact-label matching kept when a ref resolves to nothing. limit caps returned jobs newest-first (1–200, default 50); matched reports the true filtered total before the cap and omitted the rest, and claims holds regroup under the shown jobs only. Read-only: routing labels are data, never authenticated identity; claims coordinate scope and grant no execution, claim or dispatch authority; an unreadable store, registry or hold table stays unavailable or unknown, never an empty feed; no caller root, path or cwd is accepted, and the tool never writes.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: FLEET_WORK_FEED_LIMIT_MAX, default: FLEET_WORK_FEED_LIMIT_DEFAULT },
          claims: { type: 'boolean', description: 'Join live coordination holds onto each job (claims.source missing/available/unavailable; holds never leave the store).' },
          open: { type: 'boolean', description: 'Keep queued/rescheduled jobs that declare claim keys, including unknown holds; implies claims.' },
          claimable: { type: 'boolean', description: 'Keep only open jobs whose declared claim keys provably include a free one; implies claims.' },
          status: { type: 'string', enum: [...WORK_STATUSES], description: 'Keep jobs in this feed status.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep the job with this exact id.' },
          repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$', description: 'Keep jobs announced for this owner/name repo (case-insensitive, the claim-key rule).' },
          provider: { type: 'string', enum: [...PROVIDERS], description: 'Keep jobs announced for this provider.' },
          tier: { type: 'string', enum: [...WORK_TIERS], description: 'Keep jobs whose announcement declared this dispatch tier; a job with no dispatch spec declares none and never matches.' },
          to: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep jobs addressed to this agent — its routing labels and the group:<channel>:<topic> addresses of registry channels it belongs to.' },
          owner: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep jobs announced by this agent.' },
          since: { type: 'string', description: 'Keep jobs whose last activity — the newest status receipt time, or the announcement\'s while no status has moved the job — reaches the cutoff: 15m, 2h, 1d, epoch ms or an ISO time.' },
          before: { type: 'string', description: 'Keep jobs whose last activity is strictly before this cutoff on the same field — 15m, 2h, 1d, epoch ms or an ISO time; with since it reads one [since, before) window.' },
          contains: { type: 'string', minLength: 1, maxLength: BUS_WORK_FEED_CONTAINS_MAX, description: 'Case-insensitive substring over each job\'s scrubbed title, newest status detail and declared dispatch scope/acceptance.' },
          channel: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$', description: 'Keep only jobs announced to group:<channel>:* — the room\'s traffic under every topic.' },
          result: { type: 'string', enum: [...WORK_RESULT_OUTCOMES], description: 'Keep only jobs whose newest retained work.result citation carries this outcome — reported evidence that never moved the job\'s status; a job with no result never matches.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_work_board',
      description: 'Read the shared work board: the recent durable bus requests newest first, each classified RECEIVED / ASSIGNED / RUNNING / BLOCKED / VERIFIED with state, asOf, source and missing evidence plus channel and channelRef — the same listWorkBoard listing as `ashlr fleet work-board`, never a second classifier. States are evidence only and grant no dispatch, claim or merge authority; routing labels are untrusted data, never authenticated identity, and the board never includes message bodies. An unreadable inbox reports inbox "unavailable", never an invented empty board. `limit` caps returned items (1–100, default 20), `thread` keeps one exact channel_ref, `state` keeps only items the classifier placed in that state, `since` keeps only requests received at or after the cutoff (15m, 2h, 1d, epoch ms or an ISO time) and `before` keeps only requests received strictly before its own cutoff on the same grammar — the pair reading one [since, before) window on the request\'s recorded receivedAt, the same bound every bus read applies; under `state` or a time bound the response also reports `matched`, the true filtered total across the whole settled scan before the cap. Reads the server-owned default fleet root only — no caller root, path or cwd is accepted — and the tool never writes, renews TTL, claims, dispatches or merges anything.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: WORK_BOARD_MAX_LIMIT, default: 20 },
          thread: { type: 'string', maxLength: 512, description: 'Exact channel_ref filter such as a Slack <team>/<channel>/<threadTs>.' },
          state: { type: 'string', enum: [...WORK_ITEM_STATES], description: 'Keep only items classified into this state; matched reports the true filtered total before the display cap.' },
          since: { type: 'string', description: 'Keep requests received at or after the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the same grammar `ashlr fleet work-board --since` takes.' },
          before: { type: 'string', description: 'Keep requests received strictly before the cutoff: 15m, 2h, 1d, epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window; the same grammar `ashlr fleet work-board --before` takes.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_coordination_claims',
      description: 'Read-only fresh claims from the host coordination ledger, newest first (at most 50, task capped at 200 characters). Claims are advisory and grant no execution authority. Unknown means ownership is unknown, not absent. Returns no messages, proposals or lease material. Takes no arguments; no caller path, root or working directory is accepted.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_coordination_returns',
      description: "Read-only retained RESULT receipts from this computer's coordination ledger, newest first, at most 50, including PR and head evidence — the same projectCoordinationReturns projection `phm fleet coordination returns` serves. `claim` keeps one claim id's receipts; `repo` one repo (owner/name, case-insensitive); `result` one verdict (VERIFIED or BLOCKED); `from` one sender label; `since` (15m, 2h, 1d, epoch ms or ISO) keeps receipts at or after the cutoff and `before` keeps receipts strictly before its own cutoff — the pair reading one [since, before) window on each receipt's at stamp; `contains` keeps receipts whose repo, verdict, evidence kind or evidence text carries the needle as a case-insensitive substring. The filters narrow the parsed set before the newest-50 page, so a filtered read reaches receipts the unfiltered cap hides, and coverage.matched/coverage.omitted keep the filtered truncation honest. VERIFIED means the returning agent named that evidence, not that Phantom checked the PR; unknown means unknown, not absent. No caller path, root or cwd is accepted; never writes, and grants no merge, verify, dispatch or delivery authority.",
      inputSchema: {
        type: 'object',
        properties: {
          claim: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Keep only receipts whose RESULT claim field names this claim id — the same `phm fleet coordination returns --claim` match.' },
          repo: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$', description: 'Keep only receipts for this owner/name repo, compared case-insensitively — the same `--repo` match.' },
          result: { type: 'string', enum: ['VERIFIED', 'BLOCKED'], description: 'Keep only receipts carrying this RESULT verdict — the same `--result` match.' },
          from: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Keep only receipts one sender label posted — the ledger\'s agent labels are coordination names, never resolved through the bus registry; the same `--from` match.' },
          since: { type: 'string', description: 'Keep receipts at or after the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the same grammar `phm fleet coordination returns --since` takes; inclusive on each receipt\'s at stamp.' },
          before: { type: 'string', description: 'Keep receipts strictly before the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the exclusive upper bound composing with `since` into one [since, before) window, the same grammar `--before` takes.' },
          contains: { type: 'string', minLength: 1, maxLength: 512, description: 'Case-insensitive substring over each receipt\'s repo, verdict, evidence kind and evidence text — the same `--contains` match.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_runtime_identity',
      description: 'Read sanitized runtime identity: host, platform, asOf, installedVersion versus sourceVersion with versionDrift, fleetState freshness (mtime, age, stale), tailnet name and reasons — the same readRuntimeIdentity evidence as `ashlr fleet runtime-identity`. Evidence only; it grants no dispatch, claim or merge authority. Paths, addresses and token-shaped text are redacted by the reader. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_runtime',
      description: 'Read-only sanitized runtime and coordination evidence with one asOf, the same snapshot as `ashlr fleet runtime`. Evidence only; it grants no dispatch, claim or merge authority. An MCP server on another computer reads that computer\'s state. Takes no arguments; no caller root, path or cwd is accepted, and the tool never writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_surface_owner',
      description: "Read-only sanitized ownership evidence for a named surface: live advisory claims and landed origin/master history. Claims grant no dispatch, claim or merge authority. Reads this computer's ledger; no caller root, path or cwd is accepted, and the tool never writes anything.",
      inputSchema: { type: 'object', properties: { surface: { type: 'string', enum: Object.keys(SURFACES) } }, required: ['surface'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_peer_ledger',
      description: PEER_LEDGER_NOTE,
      inputSchema: { type: 'object', properties: {
        fromAgent: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        target: { type: 'string', pattern: '^[a-zA-Z0-9_.:/#-]{1,128}$' },
      }, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_session_handoff',
      description: SESSION_HANDOFF_NOTE,
      inputSchema: { type: 'object', properties: { job: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$' } }, required: ['job'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_claim_execution',
      description: 'Read-only sanitized claim execution evidence: which live advisory claims have a matching worker process on this computer. RUNNING requires a matched worker; otherwise CLAIMED_NO_WORKER or UNKNOWN. Grants no dispatch, claim or merge authority. Accepts no arguments and never writes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_channel_health',
      description: 'Read Slack and iMessage bridge channel health (LIVE / DEGRADED / BLOCKED / UNKNOWN per channel with proof and asOf) — the same readChannelHealth report as `ashlr fleet channel-health`. Evidence only; it grants no send, dispatch or merge authority. The read is time-bounded: a throw or timeout returns { status: "unknown", reason } and never an invented healthy report. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_channels_overview',
      description: 'Read the owner-channel matrix — the same readChannelsOverview projection `phm channels` and GET /api/channels serve, where fleet_channel_health answers only the Slack/iMessage bridge slice. One row per channel the owner can reach the Leader on (email, Telegram, iMessage, mobile, desktop app, Phantom page, terminal, Slack) reports connected, not-set-up, failing or unknown with last inbound/outbound times, 24 h message counts, verified senders, the one plain next step and a masked address (last four characters at most; reasons and next steps are path- and email-redacted by the projection). A channel whose source cannot be read reports unknown — never a guessed zero — and counts stay measured, so an agent can tell which channels can reach Mason and which are silently down in one call. Takes no arguments — every store root (config, inbox, email-drop, bridge health, remote-device registry) stays server-owned and any argument is refused. Read-only: the projection only joins existing reads, writes nothing and sends nothing; a throwing overview read reports status unavailable, never an invented healthy matrix; no caller root, path or cwd is accepted, and the tool grants no send, pairing, dispatch or merge authority.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_tailnet_peers',
      description: 'Read the sanitized tailnet peer list: self host name and each peer\'s name, OS, online, lastSeen, ageSeconds, reasons and asOf — the same readTailnetPeers evidence as `ashlr fleet tailnet-peers`. Evidence only; it grants no dispatch, claim, network or merge authority. No addresses, DNS names or keys are returned. The read is time-bounded: a throw or timeout returns { status: "unknown", reason } and never an invented peer list. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_pool_reach',
      description: 'Read whether the node pool\'s primary and backup SSH aliases match online tailnet peers: asOf, self, role and per-slot hosts (slot, alias, matched, online, lastSeen, ageSeconds, isSelf) plus reasons — the same readPoolReach evidence as `ashlr fleet pool-reach`. Evidence only; it grants no SSH, dispatch, failover, claim or merge authority. No addresses, DNS names or keys are returned. The read is time-bounded: a throw or timeout returns { status: "unknown", reason } and never an invented host list. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_review_pick',
      description: "Read one currently unowned review task with repository, PR/head and current owner, as in ashlr fleet review-pick. Evidence only; grants no claim or execution authority. owner: 'none' is returned only when every ownership source read cleanly. Optional repo (owner/name, default ashlrai/phantom) and limit (integer 1-100). Invalid values return status invalid. Overall read bound: 20 seconds; unavailable evidence withholds the pick. No caller root, path, cwd or runsDir is accepted.",
      inputSchema: { type: 'object', properties: { repo: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_order_state',
      description: 'Read Mason\'s inbox order states: each order classified RECEIVED / ASSIGNED / RUNNING / BLOCKED / VERIFIED with at, source, key, asOf, evidenceSource, missing evidence, pr, owner and blocker, plus live and lanes source health — the same readOrderTrace plus one listLiveWorkers snapshot and one readLaneTargets read as `ashlr fleet order-state`. A BLOCKED row\'s blocker names the held lane dependency (lane and held-until only, never hold reasons or attribution); blocker is null when no healthy lane evidence supports BLOCKED. Evidence only; it grants no claim, dispatch or merge authority, and a queued line names an owner but is not a claim. Each read is bounded to 8 seconds: a trace read that throws or times out returns sources "unavailable" with no orders, an unavailable live read leaves RUNNING unproven, and an unavailable lanes read leaves BLOCKED unproven — never an invented state. `sinceHours` is an optional integer 1-720 windowing the orders; anything else returns { status: "invalid" }. No order text bodies, file paths, command lines or pids are returned; no caller root, path or cwd is accepted, and the tool never writes anything.',
      inputSchema: { type: 'object', properties: { sinceHours: { type: 'integer', minimum: 1, maximum: 720 } }, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_claim_notices',
      description: 'Read the same Slack claim-notice evidence as the desktop view: bound threads, sent notices and pending ASSIGNED / RELEASED / BLOCKED / VERIFIED notices. A `sent` row means a durable bus note was written, not that Slack delivered it; pending rows are a dry-run plan. Authority none: never sends, ledgers or writes. The read is bounded to 5 seconds; a throw or timeout returns { status: "unknown", reason } without thrown text. Takes no arguments; any argument is refused.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_slack_replies',
      description: 'Read the Slack reply binding: which ingested Slack requests have a same-thread `sent` receipt (answered) and which do not (unanswered), with state, oldestUnansweredAt, uncertainSends, rejected, futureDated, a capped unansweredSample (channelId, threadTs, messageTs, at) and asOf, from the same replies section as the Slack bridge status. Lets an agent tell RECEIVED from answered. Evidence only; it grants no send, dispatch or merge authority, and an `attempted` send is never counted as an answer. The read is time-bounded: a throw or timeout returns { status: "unknown", reason } and never an invented answered or unanswered count. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_slack_evidence',
      description: 'Read the durable Slack evidence bundle for one thread through the same readSlackEvidenceBundle collector as `phm fleet slack-evidence` — never a second join: the bundle keeps its schema, scope, thread, asOf, rows, counts, sources (journal and sends state) and optional freshness verdict verbatim — persisted local journal and send-store evidence only, never proof of current runtime reachability, durable task ownership, execution, or a live claim. `thread` is a required Slack thread timestamp, `channelId` an optional Slack channel id restricting rows to that channel (counts and freshness recomputed from the filtered rows, matching `--channel` on the CLI), `messageTs` an optional Slack message timestamp that requires `channelId` and selects exactly one request — rows, counts and freshness are recomputed for the selected message only and the result echoes `selection`, matching `--message` on the CLI — and `maxAgeSeconds` an optional positive integer freshness bound reported as fresh/stale/unknown; a collector failure returns fixed unavailable evidence with the requested selection and no raw exception or private path. No caller directory, root, cwd, path, send, enqueue or claim option is accepted, and the tool never sends, enqueues, claims, probes or writes anything.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', pattern: '^\\d{1,20}\\.\\d{1,10}$', description: 'Exact Slack thread root timestamp such as 1731000000.000100.' },
          channelId: { type: 'string', pattern: '^[CDG][A-Z0-9]{2,32}$', description: 'Optional Slack channel id such as C0123ABCDEF; restricts the bundle to that channel.' },
          messageTs: { type: 'string', pattern: '^\\d{1,20}\\.\\d{1,10}$', description: 'Optional Slack message timestamp such as 1731000010.000100; requires channelId and selects exactly one request, matching --message on the CLI.' },
          maxAgeSeconds: { type: 'integer', minimum: 1, description: 'Optional positive safe-integer freshness bound; omitted returns no freshness verdict.' },
        },
        required: ['thread'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_slack_status',
      description: 'Read the full offline Slack bridge status — the same buildSlackBridgeStatus report `phm channels slack status --json` serves: agent-network config and [slack] section state, bridge ids, phm_ credential reference names (never values), topic-to-channel mappings, team identity counts, comms confirmation, journal state with ignored-reason buckets, reply-binding counters, receipt-backed work items, readiness, the always-unknown transport triple and the next step. fleet_channel_health answers only the LIVE/DEGRADED verdict and fleet_slack_replies only the replies slice; this is the whole report in one call. Offline only — no socket, Web API call or credential read — and `config.path` reports its basename only, never an absolute host path. Unknown stays unknown: a missing or degraded journal stays missing/degraded and unreadable counts stay absent, never an invented zero. The read is bounded to 5 seconds: a throw or timeout returns { status: "unknown", reason } with no counts and no raw exception text. Evidence only; it grants no send, dispatch or merge authority. Takes no arguments (any argument is refused) and accepts no caller root, path or cwd; the tool never writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_lanes',
      description: 'Read a persisted per-lane posture: running/target counts, hold state with holder attribution, reason and expiry, plus resource-ledger usage (used percent, credits remaining, reset time, burn rate, window). A persisted observation only — no tool starts, holds, releases, or otherwise changes a lane.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_unfed',
      description: 'Read the shared work queue\'s per-resource utilization and unfed capacity — the same readUnfedReport assembly `phm fleet unfed --json` serves, where fleet_lanes reports each lane\'s posture (running/target/hold/usage) and fleet_work_feed lists the jobs themselves but neither answers "which lanes have free slots while runnable rows wait under another lane\'s hint, and why". The result is the fleet.unfed.v1 report: per lane running, target, held, utilization, headroom, readyHinted, waitingElsewhere, unfed and the blocked reason-code counts, plus waiting, invalidRows, unfedLanes, unfedSlots, the fleetStop verdict (admission_stopped, global_admission or null), source (dispatcher or derived), derivedReasons, statusAsOf and statusFresh — a stale or untimestamped snapshot is reported flagged, never hidden. The window folds cover the last windowHours (default 24, at most 168 — the same bound --window enforces): history (unfed ticks, slot-ticks lost and leading blocked reasons per lane), overrides (route decisions that left the hinted lane, by reason and hinted-to-chosen lane), rejections (per-lane refusal codes), claims (jobs.jsonl launches that left their hint — events, not distinct jobs) and decisionOutcomes (each decided job joined to its recorded merge outcome by how the hint fared). Honesty is the report\'s own: each fold keeps available/truncated/jobsAvailable flags so a missing market log or tail-truncated ledger stays a lower bound or unknown — never an invented zero — and an absent or unreadable queue/status.json reports { status: "unavailable" }, never an invented all-fed fleet. `windowHours` is the only argument; every store root stays server-owned — no caller root, path, cwd or runsDir is accepted — and the tool never writes, launches, holds, releases, claims or dispatches anything; counts, lane names and reason codes only, never job ids, task text or credentials.',
      inputSchema: {
        type: 'object',
        properties: {
          windowHours: { type: 'number', exclusiveMinimum: 0, maximum: 168, description: 'Fold window in hours for the history/override/claims/outcome/rejection sections — the same bound `phm fleet unfed --window` enforces; omitted means the 24-hour default.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_usage_resets',
      description: 'Read the usage-reset detector evidence per lane: state (reset-detected, reset-time-passed, hold-expired, consistent, stale-reading, no-reading, manual-hold, open), held/heldBy/heldUntil, usedPct, readingAsOf, resetAt and releasable, with the overall sourceState. releasable is evidence only and never authorizes a release; it is false unless sourceState is healthy, and manual holds stay manual. Takes no arguments, reads default configured roots only, and never releases a hold, probes a provider or changes a lane.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_reset_await',
      description: 'Wait for newly observed reset evidence from the configured default root. Observed is evidence only, not a release, lane health or successful launch. No provider probes or lane changes. Pass a saved after watermark to also count evidence recorded after it while the supervisor was offline.',
      inputSchema: { type: 'object', properties: {
        lane: { type: 'string', pattern: '\\S', description: 'Exact case-sensitive nonblank lane.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_AWAIT_MS },
        pollMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_AWAIT_MS, description: 'Must not exceed timeoutMs; defaults to timeoutMs.' },
        after: { type: 'string', format: 'date-time', description: 'Optional RFC 3339 watermark with explicit offset (Z or ±HH:MM). Evidence must be strictly after it and no later than now; equal, older or future evidence never counts. Omitted means evidence after invocation time.' },
      }, required: ['lane', 'timeoutMs'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_reset_group_await',
      description: 'Wait for newly observed reset evidence across lanes from the configured default root in one bounded call. Evidence is not release authority, free quota, lane health or launch success. No provider probes or lane changes.',
      inputSchema: { type: 'object', properties: {
        lanes: { type: 'array', minItems: 1, maxItems: RESET_GROUP_AWAIT_MAX_LANES, uniqueItems: true,
          items: { type: 'string', pattern: LANE_ID_RE.source } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_AWAIT_MS },
        pollMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_AWAIT_MS, description: 'Must not exceed timeoutMs; defaults to timeoutMs.' },
      }, required: ['lanes', 'timeoutMs'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_reset_release_await',
      description: 'Wait for proof that the reset loop recorded releasing a lane hold: resolves "recorded" only once the bounded audit log gains a line for the exact lane stamped after invocation and no later than the current wall clock — older, unparsable or future-dated lines never satisfy it. "recorded" is past audit evidence, never present lane health or successful dispatch. Reads the configured default root only and never releases a hold, probes a provider or changes a lane.',
      inputSchema: { type: 'object', properties: {
        lane: { type: 'string', pattern: '\\S', description: 'Exact case-sensitive nonblank lane.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_RELEASE_AWAIT_MS },
        pollMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_RELEASE_AWAIT_MS, description: 'Must not exceed timeoutMs; defaults to timeoutMs.' },
      }, required: ['lane', 'timeoutMs'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_reset_history',
      description: 'Read the recorded autobackoff release history from the bounded audit log, newest first: lane, at, state, usedPct, readingAsOf and heldUntil per release. An exact case-sensitive lane filter scans up to 200 records before matching. This is recorded release history — completed past releases, never a live lane-health or launch-success verdict — and an empty records list means no recorded releases were returned, not that the source is healthy. Reads the configured default root only and never releases a hold, probes a provider or changes a lane.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_HISTORY, default: 20 },
          lane: { type: 'string', description: 'Exact case-sensitive lane name filter, applied before the limit.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_reset_follow',
      description: 'Follow the recorded autobackoff release audit and collect newly recorded lane releases across lanes in one bounded call, oldest first: lane, at, state, usedPct, readingAsOf and heldUntil per release. Only records stamped strictly after the exclusive after watermark (default: invocation time) are collected; an exact case-sensitive lane filter can narrow them. Returns one terminal outcome — deadline, cancelled, failed, or limit when collection stopped at the 200-record bound — with read count, delivered count and the capped-source caveat. These are recorded past releases, never a live lane-health, capacity or launch-success verdict, and an empty records list means no releases were emitted inside the call, not that the source is healthy. Reads the configured default root only and never releases a hold, probes a provider or changes a lane.',
      inputSchema: { type: 'object', properties: {
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_FOLLOW_MS },
        pollMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RESET_FOLLOW_MS, description: 'Must not exceed timeoutMs; defaults to timeoutMs.' },
        lane: { type: 'string', pattern: '\\S', description: 'Exact case-sensitive nonblank lane; omit to collect every lane.' },
        after: { type: 'string', description: 'Exclusive ISO-8601 watermark: only releases stamped strictly after it are collected. Default: invocation time.' },
      }, required: ['timeoutMs'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_job_history',
      description: 'Read which repository paths a fleet job landed, newest first: bridge commits on origin/master whose subject id exactly equals the requested job, from the same bounded git scan as `phm fleet path-history --job` — never a second scanner. The scan covers at most the newest 1000 commits and returns at most `limit` matching commits; an empty or truncated result proves only what that bounded scan saw and does not prove the job never landed. Recorded merge history, never a live lane, dispatch or merge-queue verdict. The ref is fixed at origin/master: no caller ref, path, root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Exact case-sensitive fleet job id such as RQ-EXAMPLE-1; matched only against bridge(…) commit subjects, never by prefix.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_JOB_HISTORY, default: 20 },
        },
        required: ['jobId'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_job_history_batch',
      description: 'Audit up to 20 proposed fleet job ids against landed work in one bounded git scan: bridge commits on origin/master whose subject id exactly equals a requested job, from the same shared reader as `phm fleet job-history-batch` — never a second scanner. One scan of at most the newest 1000 commits serves every id in input order and keeps at most `limit` matching commits per id; a missing or truncated result proves only what that bounded scan saw and does not prove a job never landed. Recorded merge history, never a live lane, dispatch or merge-queue verdict; it never authorizes dispatch or merge. The ref is fixed at origin/master: no caller ref, path, root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          jobIds: {
            type: 'array', minItems: 1, maxItems: MAX_FLEET_JOB_HISTORY_BATCH_IDS, uniqueItems: true,
            items: { type: 'string', description: 'Exact case-sensitive fleet job id such as RQ-EXAMPLE-1; matched only against bridge(…) commit subjects, never by prefix.' },
            description: 'Distinct exact job ids; results come back in this order.',
          },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_JOB_HISTORY_BATCH_LIMIT, default: 20 },
        },
        required: ['jobIds'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_job_overlap',
      description: 'Compare literal paths touched by landed jobs on origin/master in one bounded history read. Empty or truncated evidence is not proof of safety or permission to dispatch.',
      inputSchema: { type: 'object', properties: {
        jobIds: { type: 'array', minItems: JOB_OVERLAP_MIN_IDS, maxItems: JOB_BATCH_MAX, uniqueItems: true, items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: JOB_LIMIT_MAX, default: 20 },
      }, required: ['jobIds'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_job_current_batch',
      description: 'Compare what multiple fleet jobs landed with what origin/master holds now: for up to 20 jobs, the git tree entry — mode, type and object id — each touched path held at the newest bridge commit on origin/master versus the pinned current origin/master tree, all resolved against one immutable snapshot, from the same shared reader as `phm fleet job-current-batch` — never a second scanner. At most the newest 1000 commits are scanned and at most 200 touched paths per job compared; empty or truncated evidence proves only what the bounded scan saw and does not prove a job never landed. Statuses are object identity only — unchanged, changed, absent-now and absent-at-both — and object identity is evidence, not proof of correct behavior or permission to recut. The ref is fixed at origin/master: no caller ref, path, root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          jobIds: {
            type: 'array', minItems: 1, maxItems: MAX_FLEET_JOB_CURRENT_BATCH_IDS, uniqueItems: true,
            items: { type: 'string', description: 'Exact case-sensitive fleet job id such as RQ-EXAMPLE-1; matched only against bridge(…) commit subjects, never by prefix.' },
            description: 'Distinct exact job ids; results come back in this order.',
          },
        },
        required: ['jobIds'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_job_current',
      description: 'Compare what a fleet job landed with what origin/master holds now: for the newest bridge commit on origin/master whose subject id exactly equals the requested job, the git tree entry — mode, type and object id — each touched path held at the commit versus the pinned current origin/master tree, from the same bounded reader as `phm fleet job-current` — never a second scanner. At most the newest 1000 commits are scanned and at most 200 touched paths compared; empty or truncated evidence proves only what the bounded scan saw and does not prove the job never landed. Statuses are object identity only — unchanged, changed, absent-now and absent-at-both, where a landed deletion still absent is consistency evidence, never missing work — and none of it is a correctness, live lane, dispatch or merge-queue verdict. The ref is fixed at origin/master: no caller ref, path, root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Exact case-sensitive fleet job id such as RQ-EXAMPLE-1; matched only against bridge(…) commit subjects, never by prefix.' },
        },
        required: ['jobId'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_intent_read',
      description: 'Read the local owner-directive intent ledger (ashlr.intent-ledger/v1) through the same store as `ashlr fleet intent-read`. action "list" returns compact rows (id, title, status, source, owner, RQ keys, partial, lastTouchedAt), optionally for one status, with the total matching count and a truncated flag (default limit 25, max 100). action "get" returns one directive in full — pulls, evidence and provenance — or found:false for an unknown id. A missing ledger is an empty result; a corrupt, oversized or symlinked ledger is a tool error, never an empty success. No caller path, root, environment or command is accepted, and the tool never writes or changes a directive status.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get'], description: 'list directives or get one by id.' },
          status: { type: 'string', enum: [...INTENT_STATUSES], description: 'list only: keep directives with this exact status.' },
          id: { type: 'string', description: 'get only: exact directive id.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_INTENT_LIMIT, default: DEFAULT_FLEET_INTENT_LIMIT, description: 'list only: maximum rows returned.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_orchestration_read',
      description: 'Read the leader orchestration journal: specialist assignment receipts newest assignedAt first, with global status counts and every unresolved reserved receipt. Optional exact status/job filters and limit (default 25, max 100) apply to receipts; total counts matching rows before the limit. Missing state reports source:missing; corrupt or invalid state is a tool error. Authority is none. No caller path, root, environment or command; never writes, locks or sends.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['reserved', 'admitted', 'complete'] },
          job: { type: 'string', maxLength: 64 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_ORCHESTRATION_LIMIT, default: DEFAULT_FLEET_ORCHESTRATION_LIMIT },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_job_current_snapshot',
      description: 'Replay the fleet_job_current audit at one recorded immutable commit: for the newest bridge commit on origin/master whose subject id exactly equals the requested job, the git tree entry — mode, type and object id — each touched path held at the commit versus the pinned snapshot tree, from the same bounded reader as `phm fleet job-current-snapshot` — never a second scanner. The snapshot must be a full lowercase 40- or 64-character commit OID and is verified as a commit and an ancestor of origin/master before any scan; later origin/master moves never change the findings, so an MCP agent sees exactly what a CLI planner recorded. At most the newest 1000 commits are scanned and at most 200 touched paths compared; empty or truncated evidence proves only what the bounded scan saw and does not prove the job never landed. This is replay evidence, not a live reading: statuses are object identity only — unchanged, changed, absent-now and absent-at-both, where a landed deletion still absent is consistency evidence, never missing work — and none of it is a correctness, live lane, dispatch or merge-queue verdict. No caller ref, filesystem root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Exact case-sensitive fleet job id such as RQ-EXAMPLE-1; matched only against bridge(…) commit subjects, never by prefix.' },
          snapshot: { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$', description: 'Full lowercase 40- or 64-character commit OID recorded earlier; verified as a commit and an ancestor of origin/master before the replay. Not a live ref.' },
        },
        required: ['jobId', 'snapshot'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_job_patch',
      description: 'Read the exact bounded patch a fleet job landed: the newest bridge commit on origin/master whose subject id exactly equals the requested job, with its sha, pr, touched paths and unified diff, from the same reader as `phm fleet job-patch` — never a second scanner. Optionally narrow to one touched repository-relative path. Preserves status, resolvedRef, scan bounds and truncation flags, selectedPath and patchTruncated; the patch is capped, and outputClipped marks any further clipping to the response limit, so a clipped patch is never complete. not-found-in-bounded-scan proves only what the bounded scan saw. Read-only evidence of what landed, never a correctness verdict or permission to merge or dispatch. The ref is fixed at origin/master: no caller ref, root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Exact case-sensitive fleet job id such as RQ-EXAMPLE-1; matched only against bridge(…) commit subjects, never by prefix.' },
          path: { type: 'string', description: 'Optional repository-relative literal path that the landed commit touched; no absolute, backslash, dot or empty segments.' },
        },
        required: ['jobId'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_path_history',
      description: 'Read which landed fleet jobs touched one repository path, newest first: bridge commits on origin/master whose literal-pathspec history includes the requested path, from the same bounded git scan as `phm fleet path-history` — never a second scanner. The scan covers at most the newest limit×3 commits touching the path and returns at most `limit` distinct job ids; an empty or capped result proves only what that bounded scan saw and does not prove no job landed work on the path. Recorded merge history, never a live lane, dispatch or merge-queue verdict. The ref is fixed at origin/master: no caller ref, repository root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'Repository-relative path such as src/mcp/fleet-server.ts, matched as a literal pathspec — glob magic like * or [x] never expands. Absolute paths, .. segments, backslashes and control characters are rejected.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_PATH_HISTORY, default: 20 },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_path_cochanges',
      description: 'Read which literal repository paths historically changed with a proposed edit path, ranked by count with per-commit sha and job-id evidence: for each of the newest bridge commits on origin/master touching the requested literal-pathspec path, the companion paths changed in the same commits, from the same bounded reader as `phm fleet path-cochanges` — never a second scanner. The scan covers at most the newest 100 commits touching the path and inspects at most 20 bridge commits; the result keeps at most `limit` companion paths and reports omitted counts, and an empty or truncated result proves only what that bounded sample saw. Recorded merge evidence — cochange does not prove a dependency or authorize edits — never a live lane, dispatch or merge-queue verdict. The ref is fixed at origin/master: no caller ref, repository root or cwd is accepted, and no tool mutates anything.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'Repository-relative path such as src/mcp/fleet-server.ts, matched as a literal pathspec — glob magic like * or [x] never expands. Absolute paths, .. segments, backslashes and control characters are rejected.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_PATH_COCHANGES, default: 20 },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_job_precheck',
      description: 'Check a proposed job draft against origin/master before writing a drop file: names the src, test, docs, schema and scripts files the draft mentions (skipping Do not edit and Never touch lines), reports whether each is present on origin/master with its last commit, and returns an advisory verdict — fresh, partly-on-master or likely-done — plus the test files that would be new. With an optional exact jobId, likely-done requires each named non-test src path\'s last commit to carry that exact bridge(…) id. Path presence or last-commit identity is recorded evidence and cannot prove semantic completion. The ref is fixed at origin/master with no fetch: no caller ref, path, root or cwd is accepted, the submitted markdown is never echoed, and this tool never writes a file, enqueues, deletes, launches or merges anything.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', minLength: 1, description: 'Proposed job draft markdown, at most 8000 UTF-8 bytes. Analyzed only — never echoed back.' },
          jobId: { type: 'string', description: 'Optional exact case-sensitive fleet job id such as RQ-EXAMPLE-1; when given, likely-done requires each named non-test src path\'s last commit to be a bridge(…) commit with exactly this id.' },
        },
        required: ['markdown'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_job_precheck_batch',
      description: 'Check inline drafts together against one resolved origin/master commit, sharing path probes and reporting collisions and landed-work evidence. Advisory only; never queue, dispatch or merge authorization. No fetch or caller paths; markdown is never echoed.',
      inputSchema: { type: 'object', properties: {
        drafts: { type: 'array', minItems: 1, maxItems: JOB_PRECHECK_BATCH_MAX, items: {
          type: 'object', properties: {
            label: { type: 'string', pattern: FLEET_BATCH_LABEL_PATTERN, description: 'Unique opaque label.' },
            markdown: { type: 'string', minLength: 1, description: 'Nonblank draft, at most 8000 UTF-8 bytes.' },
          }, required: ['label', 'markdown'], additionalProperties: false,
        } },
      }, required: ['drafts'], additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_main_health',
      description: 'Read the main-guardian status table: per repo the default branch, sha, state (green, red or unknown), failing check, open fix job ids and nightly red, plus stale, guardianOff, red count and source. A persisted observation only. Unknown or stale evidence is not green. Never runs CI, opens a fix job, merges or changes a branch.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_waste_risk',
      description: 'Read the per-lane waste-risk projection: projected unused included capacity at reset, waste_risk level and recommended_target per lane, plus the count of high-risk lanes — a projection only that authorizes no target, hold or dispatch change.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_kept',
      description: 'Read why worktrees were kept: per reason (abort_push, abort_pr, empty, other, unknown) the count and the oldest job ids, from queue status and the jobs ledger tail. Observation only; never removes a worktree or requeues a job.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_trim',
      description: 'Read lanes that are starved (queued, none running, global cap full) or waste slots (low merge rate or high empty rate), with SLOTS suggestions. Advisory only; applies no target or hold change.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_email_outbox',
      description: 'Read the local email reply outbox as metadata evidence: per-state counts (queued, drafted, sent, stuck) plus a bounded list of artifact names, states and fixed stuck reasons — never recipients, subjects, bodies, absolute paths or transport errors. The saved email-drop config is resolved at the server-owned runs dir exactly like `phm fleet email-outbox` (outboxDir, else the sibling of inboxDir); a missing or invalid config and a missing or unreadable outbox directory each report their own sourceState and never invent a healthy empty outbox. The returned entry list clips at limit while counts and total describe the full listing. No caller directory, root, cwd or send option is accepted, and the tool never creates directories, sends, drafts, archives, retries or alters comms configuration.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_EMAIL_OUTBOX_ENTRIES, default: 50 } },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_email_outbox_await',
      description: 'Wait for one named email reply artifact in the local outbox to leave queued — reporting its terminal state (drafted, sent or stuck) with a fixed reason, or timedOut/cancelled — as metadata evidence: never recipients, subjects, bodies, absolute paths or transport errors. The saved email-drop config is resolved at the server-owned runs dir exactly like `phm fleet email-outbox-await` (outboxDir, else the sibling of inboxDir); missing or invalid config and a missing or unreadable outbox each report their own sourceState with a source-failure reason and never invent a healthy observation. A terminal state is observation evidence only — never permission to send — and request cancellation stops the wait. No caller directory, root, cwd or send option is accepted, and the tool never creates directories, sends, drafts, archives, retries or alters comms configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact artifact file name such as order-1.reply.eml; must end in .reply.eml and is never a path.' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS },
          pollMs: { type: 'integer', minimum: MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, default: DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, description: 'Poll interval; defaults to 1000.' },
        },
        required: ['name', 'timeoutMs'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_comms_readiness',
      description: 'Read local email and iMessage cutover capability evidence, including unverified Gmail triage and LinkedIn. Local readiness is not delivery or retirement proof. No arguments, message content, sends or mutations.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_email_outbox_batch_await',
      description: 'Wait for up to 50 named email reply artifacts in the local outbox to leave queued in one bounded call — reporting each row\'s state (queued, drafted, sent, stuck or missing) with a fixed stuck reason, or timedOut/cancelled — as metadata evidence: never recipients, subjects, bodies, absolute paths or transport errors. The saved email-drop config is resolved at the server-owned runs dir exactly like `phm fleet email-outbox-batch-await` (outboxDir, else the sibling of inboxDir); missing or invalid config and a missing or unreadable outbox each report their own sourceState with sourceFailure true and null rows, never an invented healthy observation. A terminal row is observation evidence only — drafted means drafted, never sent or delivered, and nothing here is permission to send — and request cancellation stops the wait. No caller directory, root, cwd or send option is accepted, and the tool never creates directories, sends, drafts, archives, retries or alters comms configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array', minItems: 1, maxItems: MAX_FLEET_EMAIL_OUTBOX_BATCH_AWAIT_NAMES, uniqueItems: true,
            items: { type: 'string' },
            description: 'Distinct exact artifact file names such as order-1.reply.eml; each must end in .reply.eml and is never a path. Rows come back in this order.',
          },
          timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS },
          pollMs: { type: 'integer', minimum: MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, default: DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, description: 'Poll interval; defaults to 1000.' },
        },
        required: ['names', 'timeoutMs'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_comms_inbox',
      description: 'Read the ranked unified comms inbox — the same readUnifiedInbox projection `phm comms inbox` serves. Optional source, kind, severity, blocking, job, since, before and contains narrow the item list with the same rules as the CLI flags; the per-source pending reports stay the unfiltered store truth and an applied filter is echoed on the result. limit caps returned items (1–200, default 50). Read-only; items quote private text.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          source: { type: 'string', enum: [...UNIFIED_INBOX_SOURCES], description: 'Keep items from one unified-inbox source.' },
          kind: { type: 'string', enum: [...UNIFIED_INBOX_KINDS], description: 'Keep items of one kind — the item\'s own classification, finer than source where one source emits several kinds (the bus source\'s bus-work/bus-handoff split, the board source\'s board-delivery/board-task split).' },
          severity: { type: 'string', enum: ['info', 'warn', 'high'], description: 'Keep items of one severity.' },
          blocking: { type: 'boolean', description: 'true keeps only blocking items; false keeps only non-blocking items.' },
          job: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$', description: 'Keep only items whose citation set names this job id.' },
          since: { type: 'string', description: 'Keep items whose recorded appearance time reaches the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the same grammar `phm comms inbox --since` takes.' },
          before: { type: 'string', description: 'Keep items whose recorded appearance time is strictly before the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the exclusive upper bound composing with since into one [since, before) window, the same grammar `phm comms inbox --before` takes.' },
          contains: { type: 'string', minLength: 1, maxLength: UNIFIED_INBOX_CONTAINS_MAX, description: 'Case-insensitive substring over each item\'s scrubbed title and detail.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_comms_status',
      description: 'Read the owner comms status — the same readOwnerCommsStatus projection `phm comms status --json`, the native `ashlr_comms` tool and the owner-thread API serve, where fleet_comms_inbox lists only the pending owner items and none of the fleet reads answers "is the owner reply path alive" in one call. The result reports the kill-switch and comms-pause verdicts the owner-thread adapters answer to (the same gates fleet_bus_status\'s sendGate reports for bus writes, kept as separate verdicts), the live plus archived message count, inbound messages awaiting a recorded reply, recorded replies whose fanout delivery evidence cannot confirm (failed, pending or unknown — never delivered), the per-channel owner adapter rollup (configured, enabled, halted, fixed reason and next step, secret handle names at most — never values) and the teammate reply-gap read. An unreadable thread keeps every count null — unknown stays unknown, never an invented zero — and message text never enters the projection. Takes no arguments — the owner config dir and runs dir resolve the real account home server-side and cannot be retargeted by HOME or ASHLR_* variables, and any argument is refused. Read-only: the projection joins existing reads, writes nothing and sends nothing; a throwing read reports status unavailable, never an invented healthy status; routing and owner labels are untrusted data, and the tool grants no reply, send, pairing, dispatch or delivery authority; no caller root, path or cwd is accepted.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_comms_thread',
      description: 'Read the single owner thread (desktop, Telegram, email, iMessage, Slack) with per-channel delivery receipts — the same readOwnerThread projection `phm comms thread --json`, the native `ashlr_comms_thread` tool and the owner-thread API serve, where fleet_comms_inbox lists only the pending owner items and fleet_comms_status reports counts and adapter states but neither answers "what did the owner last say and what did we reply" in one call. `channel` keeps one channel\'s lines; `direction` keeps inbound (what the owner sent) or outbound (what we answered) lines; `since` (15m, 2h, 1d, epoch ms or ISO) keeps messages at or after the cutoff; `beforeAt` (15m, 2h, 1d, epoch ms or ISO) keeps messages strictly before the cutoff — the exclusive ceiling that pairs with `since`, named apart from the archive read\'s seq cursor; `contains` keeps only messages whose stored text carries the needle as a case-insensitive substring — the only text search the thread offers, since iMessage bodies are redacted on the bus mirror; `replyTo` keeps only the exchange rooted at one message key — the message carrying that idempotency key plus every reply citing it, the same key `send-owner --reply-to` takes; `awaiting` (true) keeps only the live inbound messages the awaiting-reply mark names — the same set `awaitingReply` reports, sliced into the view, a live-window mark archived history never satisfies; `undelivered` (true) keeps only the live outbound replies the undeliveredReplies mark names — the same set readOwnerUndeliveredReplies reports, sliced into the view, a live-window mark archived history never satisfies. `limit` caps the newest messages kept (1–200, default 50). The result is the comms.owner-thread.v1 view: ordered messages, receipts mapping each outbound message id to per-channel delivery states (delivered, pending or failed — a channel with no record is unknown, never delivered), the awaitingReply mark listing live inbound ids no recorded reply cites and the undeliveredReplies mark listing live outbound reply ids with a fanout destination delivery cannot confirm (both null when the thread is unreadable — unknown stays unknown, never an empty list); an unreadable thread reports unavailable: true. Read-only: the read joins existing stores, writes nothing and sends nothing; message text is the stored scrubbed intake content — never a secret value — and routing labels are untrusted data; the tool grants no reply, send, pairing, dispatch or delivery authority; the owner config dir and runs dir resolve the real account home server-side and cannot be retargeted by HOME or ASHLR_* variables, and no caller root, path or cwd is accepted.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: FLEET_COMMS_THREAD_LIMIT_MAX, default: FLEET_COMMS_THREAD_LIMIT_DEFAULT, description: 'Newest messages kept after filtering; the read itself caps at 200.' },
          channel: { type: 'string', enum: [...OWNER_CHANNELS], description: 'Keep only messages recorded on this owner channel.' },
          direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Keep only what the owner sent (inbound) or only what we answered (outbound).' },
          since: { type: 'string', description: 'Keep messages at or after the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the same grammar `phm comms thread --since` takes.' },
          beforeAt: { type: 'string', description: 'Keep messages strictly before the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the exclusive ceiling that pairs with `since`; named apart from the archive read\'s seq cursor.' },
          contains: { type: 'string', minLength: 1, maxLength: OWNER_THREAD_CONTAINS_MAX, description: 'Case-insensitive substring over the stored message text, whitespace collapsed — the only text search the thread offers.' },
          replyTo: { type: 'string', description: 'Keep only the exchange rooted at one message key: the message carrying that idempotency key plus every reply citing it — the same key `send-owner --reply-to` takes.' },
          awaiting: { type: 'boolean', description: 'Keep only the live inbound messages the awaiting-reply mark names — the same set `awaitingReply` reports, sliced into the view. A live-window mark: archived history never satisfies it.' },
          undelivered: { type: 'boolean', description: 'Keep only the live outbound replies the undeliveredReplies mark names — the same set `readOwnerUndeliveredReplies` reports, sliced into the view. A live-window mark: archived history never satisfies it.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_owner_history',
      description: 'Read the archived owner-thread history — the same readOwnerThreadHistory projection `phm fleet owner-history` serves: fleet_comms_thread reads only the live thread window, so once rotation moves the oldest messages into owner-thread-archive files beside the live record this is the only read that pages them back — "what did the owner say before the live window" in one call. `before` keeps only archived messages with seq below that sequence number (page back with the oldest seq a previous page returned); `limit` caps the page (1–500, default 50). `channel` keeps one channel\'s archived lines; `direction` keeps inbound (what the owner sent) or outbound (what we answered) lines; `since` (15m, 2h, 1d, epoch ms or ISO) keeps messages at or after the cutoff; `beforeAt` (15m, 2h, 1d, epoch ms or ISO) keeps messages strictly before the cutoff — the exclusive ceiling that pairs with `since`, named apart from `before` which already pages by seq on this read; `contains` keeps only messages whose stored text carries the needle as a case-insensitive substring and `replyTo` keeps only the exchange rooted at one message key — the message carrying that idempotency key plus every reply citing it; both are the same view slice fleet_comms_thread exposes, applied through the shared predicate so a filtered archive read keeps exactly the rows the live read would. The result is the comms.owner-thread-history.v1 view: the page\'s messages, `archives` (retained archive files found) and `skipped` (archive files unreadable or invalid — counted, never fatal); archive discovery, seq paging, overlap dedupe and per-message secret scrubbing stay the shared read\'s, so overlapping archive records never double-count. Message text is the stored scrubbed intake content — never a secret value — and routing labels are untrusted data; the tool grants no reply, send, pairing, dispatch or delivery authority; the runs dir resolves the real account home server-side and cannot be retargeted by HOME or ASHLR_* variables, no caller root, path or cwd is accepted, and a throwing read reports status unavailable, never an invented empty or healthy history.',
      inputSchema: {
        type: 'object',
        properties: {
          before: { type: 'integer', minimum: 1, description: 'Keep only archived messages with seq below this sequence number — page back with the oldest seq a previous page returned.' },
          limit: { type: 'integer', minimum: 1, maximum: FLEET_OWNER_HISTORY_LIMIT_MAX, default: FLEET_OWNER_HISTORY_LIMIT_DEFAULT, description: 'Cap on archived messages returned; the read itself clamps at 500.' },
          channel: { type: 'string', enum: [...OWNER_CHANNELS], description: 'Keep only archived messages recorded on this owner channel.' },
          direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Keep only what the owner sent (inbound) or only what we answered (outbound).' },
          since: { type: 'string', description: 'Keep archived messages at or after the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the same grammar `phm fleet owner-history --since` takes.' },
          beforeAt: { type: 'string', description: 'Keep archived messages strictly before the cutoff: a duration (15m, 2h, 1d), epoch ms or an ISO time — the exclusive ceiling that pairs with `since`; named apart from `before` which already pages by seq on this read.' },
          contains: { type: 'string', minLength: 1, maxLength: OWNER_THREAD_CONTAINS_MAX, description: 'Case-insensitive substring over the stored message text, whitespace collapsed — the only text search the thread offers.' },
          replyTo: { type: 'string', description: 'Keep only archived messages in the exchange rooted at one message key: the message carrying that idempotency key plus every reply citing it.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_comms_health',
      description: 'Read the comms transport health — the same readTelegramHealth projection `phm comms health --json` serves: the Telegram poller\'s last poll and last success timestamps, whether a poll landed inside the seven-minute liveness window (pollerAlive — a recent heartbeat, never delivery proof), the last seen update id, bot-token presence as a boolean (the value never leaves the process) and the Leader tick state (never, started, completed, failed or spawn-failed). fleet_channels_overview reports each channel\'s configured/connected row and fleet_comms_status the owner-thread adapters\' rollup; neither answers "is the Telegram poller actually polling and did the Leader tick last run" in one call. Takes no arguments — the config and comms state resolve under the process home, the same root `phm comms health` reads, and any argument is refused. Read-only: the projection joins existing reads, writes nothing, sends nothing, polls nothing and alters no comms configuration; a throwing read reports status unavailable, never an invented healthy status; a missing health file reports null timestamps and pollerAlive false — never-polled is a fact, not an error — and the tool grants no send, pair, setup, dispatch or delivery authority; no caller root, path or cwd is accepted.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_email_diagnosis',
      description: 'Diagnose why local email replies are not flowing, through the same shared diagnoseEmailDrop collector as `phm comms diagnose` — never a second classifier: fixed-code config, polling, sendReplies, outbox and replies states with observed outbox counts when readable, plus the email checks and the local-evidence-only coverage marker — never recipients, subjects, bodies, absolute paths, transport errors or raw exception text. The saved email-drop config resolves at the server-owned runs dir; a missing or invalid config, a paused poll, draft-only mode and a missing or unreadable outbox each report their own fixed state and never invent healthy counts, and a collector failure is reported as fixed unavailable evidence. This is local config/outbox observation only — never proof of Gmail triage, LinkedIn coverage, sending or end-to-end delivery. Takes no arguments: no caller directory, root, cwd, path or send option is accepted, and the tool never creates directories, sends, drafts, retries or alters comms configuration.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_imessage_path',
      description: 'Diagnose the local iMessage path through the same shared checkIMessagePath collector as `ashlr fleet imessage-path` — never a second classifier: the fixed-code platform, configuration, chat.db and cursor states with reason and next step, plus the fixed transport, owner-reply, collaborator-intake and collaborator-delivery states — never handles, message text, absolute paths or raw exception text. Transport stays owner-only and collaborator intake and delivery stay unsupported exactly as the path evidence reports; configuration alone is never delivery proof. Reads the server-owned runs root only, and a collector failure is fixed unavailable evidence. Takes no arguments: no caller directory, root, cwd, path, config, probe or send option is accepted, and the tool never sends, polls, writes a cursor, runs AppleScript or alters comms configuration.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_imessage_acks',
      description: 'Read the bounded tail of recorded iMessage intake acknowledgements through the same readImessageAckEvidence collector as `phm fleet imessage-acks` — never a second reader: the acks.jsonl sourceState (ok, missing, unreadable), at most `limit` newest rows projected to timestamp, rowid, status and delivery, the malformedRows count and deliveryProof:false — never handles, message text, absolute paths or raw exception text. An accepted or duplicate acknowledgement is only a recorded intake receipt and never means a message was sent or delivered. Reads the server-owned runs root only, and a collector failure is fixed unavailable evidence. No caller directory, root, cwd, path or send option is accepted, and the tool never sends, polls, writes a cursor, runs AppleScript or alters comms configuration.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_IMESSAGE_ACKS, default: 20 } },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_imessage_tasks',
      description: 'Read the local teammate task ledger through the same listTeammateTasks collector as `phm fleet imessage-tasks list` — never a second store, reader or dispatcher: each row is projected to jobId, peer, resource, state, claimKey, createdAt/attemptedAt/deadline timestamps, the sanitized transport receipt (rowid, sent, delivered, error) and the peer-reported result (rowid, status, at, evidence) — never the envelope token, scope, format, result summary, handles, message bodies or filesystem paths. `jobId` is an optional exact selector applied before `limit` truncation (1–100, default 20, newest matches kept in collector order); an unmatched selector reports matched:false and never another task. Ledger presence is reported separately (present, missing, unavailable) so a missing or corrupt store never poses as a healthy empty assignment, and a collector failure is fixed unavailable evidence without raw exception text. Task states are local ledger states verbatim: queued is never RUNNING, a DONE result is peer-reported and unverified, and a sent receipt is never delivery proof. Reads the server-owned runs root only; no caller directory, root, cwd, path, config, send, enqueue, poll or claim option is accepted, and the tool never sends, enqueues, dispatches, claims, writes or alters comms configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$', description: 'Exact job id selector such as RQ-PHX-EXAMPLE-1; applied before limit truncation.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_IMESSAGE_TASKS, default: DEFAULT_FLEET_IMESSAGE_TASKS },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_ci_resume_inputs',
      description: 'Plan which CI jobs may reuse passing input-tree receipts after a fix — the RESUME-FROM-FAILURE order — through the same shared planCiResumeInputs planner as `phm fleet ci-resume-inputs`, never a second digest algorithm. Takes the version-1 manifest and prior-receipts documents inline as JSON objects (each at most 1 MiB serialized, never file paths) plus hexadecimal base and head revisions. Per job it returns the planner\'s structured reuse-or-rerun decision, fixed reasons, reproduced base and head input digests, covered and shared changed paths and the matched prior receipt; unknown or unmapped coverage stays a rerun. The repository is the server\'s own cwd: no caller cwd, filesystem path, executable, environment or git option is accepted. Read-only: git objects only (rev-parse, ls-tree, diff-tree), the working tree is never read, and the tool never posts a status or check, writes a receipt, dispatches a workflow or mutates CI.',
      inputSchema: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: 'Inline version-1 ci-resume manifest (repo, shared paths, jobs with covered paths); at most 1 MiB serialized — a JSON object, never a file path.' },
          prior: { type: 'object', description: 'Inline version-1 prior-receipts document (repo, receipts with stored inputsDigest); at most 1 MiB serialized — a JSON object, never a file path.' },
          base: { type: 'string', pattern: '^[0-9a-fA-F]{4,64}$', description: 'Hexadecimal revision the prior attempt ran at.' },
          head: { type: 'string', pattern: '^[0-9a-fA-F]{4,64}$', description: 'Hexadecimal revision after the fix.' },
        },
        required: ['manifest', 'prior', 'base', 'head'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_ci_receipt_await',
      description: 'Wait for one explicitly named receipts artifact on one exact GitHub Actions run attempt — the RESUME-FROM-FAILURE order — through the same shared awaitCiReceipt evidence waiter as `phm fleet ci-receipt-await`, never a second poller or artifact binder, then return the validated CiResumePrior document in the `prior` field for `fleet_ci_resume_inputs`. Pending is proven by evidence only: each poll is a bounded GET of the exact attempt\'s metadata plus the run\'s artifact list; only a positively observed running/queued attempt whose named artifact is still absent sleeps and retries, and another attempt is never substituted. Once observed, the artifact is bound through the merged discover path with producer inputsDigests preserved verbatim. Timeout, cancellation, a completed attempt without the artifact, and duplicate, expired, malformed or mismatched evidence stay tool errors — never a fabricated prior. Read-only GitHub evidence: every call is a GET metadata/listing read plus a bounded archive download; the tool never reruns CI, posts a status or check, dispatches a workflow, writes a receipt or authorizes reuse. No caller executable, cwd, environment, filesystem path or API route is accepted.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$', description: 'GitHub owner/name the run belongs to; never a path, URL or remote.' },
          run: { type: 'integer', minimum: 1, description: 'Exact workflow run id.' },
          attempt: { type: 'integer', minimum: 1, description: 'Exact run attempt number; another attempt is never substituted.' },
          artifactName: { type: 'string', minLength: 1, maxLength: 200, description: 'Exact artifact name such as ci-resume-receipts; never guessed or substituted.' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, default: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, description: 'Total wait bound, at most one hour; defaults to 600000.' },
          pollMs: { type: 'integer', minimum: CI_RECEIPT_AWAIT_MIN_POLL_MS, maximum: CI_RECEIPT_AWAIT_MAX_POLL_MS, default: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, description: 'Poll interval; defaults to 5000.' },
        },
        required: ['repo', 'run', 'attempt', 'artifactName'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_ci_receipt_await_batch',
      description: 'Wait for a bounded batch of explicitly named receipts artifacts — the RESUME-FROM-FAILURE and t1626u batching orders — in one call through the same shared awaitCiReceiptBatch waiter as `phm fleet ci-receipt-await-batch`, never a second poller or artifact binder. The whole targets document and the timeout/poll timings are validated before anything touches the network: unknown keys, malformed fields, an out-of-range or duplicate exact identity list and a serialized document over 64 KiB are all refused up front. Targets then wait strictly in input order with at most one read in flight under one shared deadline that is never refreshed per target. Each bound entry returns its exact repo/run/attempt/artifact identity and validated CiResumePrior document in the `prior` field for `fleet_ci_resume_inputs`, with producer inputsDigests preserved verbatim; a terminal failure is recorded beside its exact identity and the batch moves on while time remains; targets the deadline or cancellation never reached get explicit not-started entries — a prior is never fabricated or substituted from another entry. Read-only GitHub evidence: every call is a GET metadata/listing read plus a bounded archive download; the tool never reruns CI, posts a status or check, dispatches a workflow, writes a receipt or authorizes reuse. No caller executable, cwd, environment, filesystem path or API route is accepted.',
      inputSchema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array', minItems: 1, maxItems: CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
            description: 'Exact run/attempt/artifact identities waited on in input order, serialized and validated as the CLI\'s version-1 targets document; duplicate exact identities are refused.',
            items: {
              type: 'object',
              properties: {
                repo: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$', description: 'GitHub owner/name the run belongs to; never a path, URL or remote.' },
                run: { type: 'integer', minimum: 1, description: 'Exact workflow run id.' },
                attempt: { type: 'integer', minimum: 1, description: 'Exact run attempt number; another attempt is never substituted.' },
                artifactName: { type: 'string', minLength: 1, maxLength: 200, description: 'Exact artifact name such as ci-resume-receipts; never guessed or substituted.' },
              },
              required: ['repo', 'run', 'attempt', 'artifactName'],
              additionalProperties: false,
            },
          },
          timeoutMs: { type: 'integer', minimum: 1, maximum: CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, default: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, description: 'One shared deadline covering the whole batch, at most one hour and never refreshed per target; defaults to 600000.' },
          pollMs: { type: 'integer', minimum: CI_RECEIPT_AWAIT_MIN_POLL_MS, maximum: CI_RECEIPT_AWAIT_MAX_POLL_MS, default: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, description: 'Poll interval; defaults to 5000.' },
        },
        required: ['targets'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_release_candidate',
      description: 'Read-only release-candidate diagnostics through the same planReleaseCandidate planner as `ashlr fleet release-candidate` — never a second release implementation. For an exact owner/name repository and exact semver tag (vX.Y.Z) it correlates bounded gh api evidence: the tag commit and tree, the current master head, the ci.yml gate run on the candidate, attest-ci-build.yml run facts, the immutable producer artifact and the release row. masterMoved and treeMatch diagnose the master-moved gate-to-attestation mismatch ("trusted master tree differs from candidate"); while either side is unreadable they stay null, and missing or ambiguous evidence stays unknown or unavailable — never labeled ready. A published release row is GitHub release state only, distinct from any installed-app state. nextActions are advisory text the tool never executes; it never dispatches, signs, tags, merges or mutates anything. No caller sha, ref, path, root, cwd or runner override is accepted.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', pattern: FLEET_RELEASE_CANDIDATE_REPO_PATTERN, description: 'Exact GitHub repository owner/name such as ashlr/phantom.' },
          tag: { type: 'string', pattern: FLEET_RELEASE_CANDIDATE_TAG_PATTERN, description: 'Exact semver release tag such as v3.30.7.' },
        },
        required: ['repo', 'tag'],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_gmail_triage_latest',
      description: 'Read the last saved Gmail triage result: scanned, updates, drafted, review, failed, unreadInSample, target and archiveCandidateCount, a short directory label and the save time, plus overTarget (unreadInSample > target) and ageSeconds. Local saved counts only — never subjects, senders, bodies, message ids or absolute paths, and not proof of delivery or archiving. A missing, unreadable, oversized or invalid file reports state missing with null fields. Takes no arguments: no caller directory, root, cwd or path is accepted, and the tool never reads mail, archives, drafts or writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_disk_forecast',
      description: 'Read-only disk forecast reporting the projected 150 GB crossing, consumption rate in GB/h and advice for large writes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_gmail_archive_plan_latest',
      description: 'Read the latest saved Gmail archive plan per inbox: inbox label, save time, unread, target, archiveCount, overTarget (unread > target) and up to three top sender addresses with counts, so the Comms agent can see which inbox is over target. Optional `inbox` filter (max 64 chars); an unknown inbox returns an empty plans list. Local saved counts and sender addresses only — never subjects, bodies, message ids or absolute paths. A missing, unreadable, oversized or invalid file reports state missing with no plans. No caller directory, root, cwd or path is accepted, and the tool never moves, archives, sends or deletes mail or writes anything.',
      inputSchema: { type: 'object', properties: { inbox: { type: 'string', maxLength: 64 } }, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_self_tick_last',
      description: 'Read the last recorded self-tick pass from queue/self-tick-last.json: start time, mode (apply or dry-run), whether it ran or found the lock busy, age in seconds and the names of any failed steps. last is null when no pass was ever recorded and state unreadable when the record fails validation. Takes no arguments, reads the default runs root only, and never runs a tick, takes the self-tick lock or writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_recheck',
      description: 'Run the read-only fleet recheck verdict: runtime identity, the claims ledger, Slack/iMessage bridge channel health and the work board joined into per-section VERIFIED / UNKNOWN / BLOCKED states with missing reasons — the same readFleetRecheck() evidence as `ashlr fleet recheck`. Evidence only; it grants no dispatch, claim, send or merge authority. Takes no arguments: no caller root, path or cwd is accepted, and the tool never appends to the recheck log or writes anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_recheck_history',
      description: 'Read the retained recheck verdict rows from the local recheck log (fleet/recheck-log.jsonl): newest-first rows with per-section states and recorded missing reasons, plus skipped (malformed-line) and missing (no log yet) flags — the same readRecheckRecords() evidence as `ashlr fleet recheck-record --last`. Evidence only; it grants no dispatch, claim, send or merge authority. `last` caps returned rows (1–50, default 5). No caller root, path or cwd is accepted, and the tool never records a row or writes anything.',
      inputSchema: {
        type: 'object', properties: { last: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RECHECK_HISTORY, default: DEFAULT_FLEET_RECHECK_HISTORY } },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_bridge_check',
      description: BRIDGE_CHECK_NOTE,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    // Low-level SDK servers do not validate arguments against tools/list schemas.
    if (name !== 'fleet_staging_inventory' && name !== 'fleet_staging_inventory_retry' && name !== 'fleet_staging_inventory_batch' && name !== 'fleet_status' && name !== 'fleet_empties' && name !== 'fleet_loop' && name !== 'fleet_bus_hops' && name !== 'fleet_host_runs' && name !== 'fleet_bus_inbox' && name !== 'fleet_agent_inbox' && name !== 'fleet_agent_work' && name !== 'fleet_agent_wakes' && name !== 'fleet_agent_messages' && name !== 'fleet_agent_channels' && name !== 'fleet_agent_identity' && name !== 'fleet_agent_conversations' && name !== 'fleet_agent_roster' && name !== 'fleet_bus_channel' && name !== 'fleet_bus_show' && name !== 'fleet_bus_thread' && name !== 'fleet_bus_status' && name !== 'fleet_bus_claims' && name !== 'fleet_bus_board' && name !== 'fleet_seat_handoffs' && name !== 'fleet_bot_seats' && name !== 'fleet_work_feed' && name !== 'fleet_work_board' && name !== 'fleet_coordination_claims' && name !== 'fleet_coordination_returns' && name !== 'fleet_runtime_identity' && name !== 'fleet_runtime' && name !== 'fleet_peer_ledger' && name !== 'fleet_session_handoff' && name !== 'fleet_surface_owner' && name !== 'fleet_claim_execution' && name !== 'fleet_channel_health' && name !== 'fleet_channels_overview' && name !== 'fleet_tailnet_peers' && name !== 'fleet_pool_reach' && name !== 'fleet_review_pick' && name !== 'fleet_order_state' && name !== 'fleet_claim_notices' && name !== 'fleet_slack_replies' && name !== 'fleet_slack_evidence' && name !== 'fleet_slack_status' && name !== 'fleet_lanes' && name !== 'fleet_unfed' && name !== 'fleet_usage_resets' && name !== 'fleet_reset_history' && name !== 'fleet_reset_await' && name !== 'fleet_reset_group_await' && name !== 'fleet_reset_release_await' && name !== 'fleet_reset_follow' && name !== 'fleet_job_history' && name !== 'fleet_job_history_batch' && name !== 'fleet_job_current_batch' && name !== 'fleet_job_current' && name !== 'fleet_job_current_snapshot' && name !== 'fleet_job_patch' && name !== 'fleet_job_overlap' && name !== 'fleet_path_history' && name !== 'fleet_path_cochanges' && name !== 'fleet_job_precheck' && name !== 'fleet_job_precheck_batch' && name !== 'fleet_main_health' && name !== 'fleet_waste_risk' && name !== 'fleet_kept' && name !== 'fleet_trim' && name !== 'fleet_email_outbox' && name !== 'fleet_email_outbox_await' && name !== 'fleet_email_outbox_batch_await' && name !== 'fleet_email_diagnosis' && name !== 'fleet_gmail_triage_latest' && name !== 'fleet_disk_forecast' && name !== 'fleet_gmail_archive_plan_latest' && name !== 'fleet_comms_inbox' && name !== 'fleet_comms_status' && name !== 'fleet_comms_thread' && name !== 'fleet_owner_history' && name !== 'fleet_comms_health' && name !== 'fleet_comms_readiness' && name !== 'fleet_imessage_path' && name !== 'fleet_imessage_acks' && name !== 'fleet_imessage_tasks' && name !== 'fleet_ci_resume_inputs' && name !== 'fleet_ci_receipt_await' && name !== 'fleet_ci_receipt_await_batch' && name !== 'fleet_release_candidate' && name !== 'fleet_orchestration_read' && name !== 'fleet_intent_read' && name !== 'fleet_self_tick_last' && name !== 'fleet_recheck' && name !== 'fleet_recheck_history' && name !== 'fleet_bridge_check') {
      throw new McpError(ErrorCode.InvalidParams, 'Unknown fleet tool.');
    }
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid fleet tool arguments.');
    }
    const surfaceOwner = name === 'fleet_surface_owner' ? parseFleetSurfaceOwnerArgs(args) : null;
    const claimExecution = name === 'fleet_claim_execution' ? parseFleetClaimExecutionArgs(args) : null;
    const retry = name === 'fleet_staging_inventory_retry' ? await retryStagingInventory(args, readers.stagingScanner) : null;
    const stagingRoots = name === 'fleet_staging_inventory_batch' ? parseStagingBatchArgs(args) : null;
    const fleetStagingInventory = name === 'fleet_staging_inventory' ? parseFleetStagingInventoryArgs(args) : null;
    const limited = name === 'fleet_loop';
    const maxLimit = MAX_FLEET_TICKS;
    const limit = args['limit'] ?? 20;
    const emptyHours = args['hours'] === undefined ? 24 : args['hours'];
    const busHopsArgs = name === 'fleet_bus_hops' ? parseFleetBusHopsArgs(args) : null;
    const inbox = name === 'fleet_bus_inbox' ? parseFleetBusInboxArgs(args) : null;
    const agentInboxArgs = name === 'fleet_agent_inbox' ? parseFleetAgentInboxArgs(args) : null;
    const agentWorkArgs = name === 'fleet_agent_work' ? parseFleetAgentWorkArgs(args) : null;
    const agentWakesArgs = name === 'fleet_agent_wakes' ? parseFleetAgentWakesArgs(args) : null;
    const agentMessagesArgs = name === 'fleet_agent_messages' ? parseFleetAgentMessagesArgs(args) : null;
    const agentChannelsArgs = name === 'fleet_agent_channels' ? parseFleetAgentChannelsArgs(args) : null;
    const agentIdentityArgs = name === 'fleet_agent_identity' ? parseFleetAgentIdentityArgs(args) : null;
    const agentConversationsArgs = name === 'fleet_agent_conversations' ? parseFleetAgentConversationsArgs(args) : null;
    const agentRosterArgs = name === 'fleet_agent_roster' ? parseFleetAgentRosterArgs(args) : null;
    const busChannelArgs = name === 'fleet_bus_channel' ? parseFleetBusChannelArgs(args) : null;
    const busShowArgs = name === 'fleet_bus_show' ? parseFleetBusShowArgs(args) : null;
    const busThreadArgs = name === 'fleet_bus_thread' ? parseFleetBusThreadArgs(args) : null;
    const busStatusArgs = name === 'fleet_bus_status' ? parseFleetBusStatusArgs(args) : null;
    const busClaimsArgs = name === 'fleet_bus_claims' ? parseFleetBusClaimsArgs(args) : null;
    const busBoardArgs = name === 'fleet_bus_board' ? parseFleetBusBoardArgs(args) : null;
    const seatHandoffsArgs = name === 'fleet_seat_handoffs' ? parseFleetSeatHandoffsArgs(args) : null;
    const botSeatsArgs = name === 'fleet_bot_seats' ? parseFleetBotSeatsArgs(args) : null;
    const workFeedArgs = name === 'fleet_work_feed' ? parseFleetWorkFeedArgs(args) : null;
    const workBoard = name === 'fleet_work_board' ? parseFleetWorkBoardArgs(args) : null;
    const coordinationReturnsArgs = name === 'fleet_coordination_returns' ? parseFleetCoordinationReturnsArgs(args) : null;
    const reviewPick = name === 'fleet_review_pick' ? parseFleetReviewPickArgs(args) : null;
    const orderState = name === 'fleet_order_state' ? parseFleetOrderStateArgs(args) : null;
    const history = name === 'fleet_reset_history' ? parseFleetResetHistoryArgs(args) : null;
    const resetGroupAwait = name === 'fleet_reset_group_await' ? parseFleetResetGroupAwaitArgs(args) : null;
    const resetAwait = name === 'fleet_reset_await' ? parseFleetResetAwaitArgs(args) : null;
    const resetReleaseAwait = name === 'fleet_reset_release_await' ? parseFleetResetReleaseAwaitArgs(args) : null;
    const resetFollow = name === 'fleet_reset_follow' ? parseFleetResetFollowArgs(args) : null;
    const jobHistory = name === 'fleet_job_history' ? parseFleetJobHistoryArgs(args) : null;
    const jobHistoryBatch = name === 'fleet_job_history_batch' ? parseFleetJobHistoryBatchArgs(args) : null;
    const jobOverlap = name === 'fleet_job_overlap' ? parseFleetJobOverlapArgs(args) : null;
    const jobCurrentBatch = name === 'fleet_job_current_batch' ? parseFleetJobCurrentBatchArgs(args) : null;
    const jobCurrent = name === 'fleet_job_current' ? parseFleetJobCurrentArgs(args) : null;
    const jobCurrentSnapshot = name === 'fleet_job_current_snapshot' ? parseFleetJobCurrentSnapshotArgs(args) : null;
    const jobPatchArgs = name === 'fleet_job_patch' ? parseFleetJobPatchArgs(args) : null;
    const pathHistory = name === 'fleet_path_history' ? parseFleetPathHistoryArgs(args) : null;
    const pathCochanges = name === 'fleet_path_cochanges' ? parseFleetPathCochangesArgs(args) : null;
    const jobPrecheck = name === 'fleet_job_precheck' ? parseFleetJobPrecheckArgs(args) : null;
    const jobPrecheckBatch = name === 'fleet_job_precheck_batch' ? parseFleetJobPrecheckBatchArgs(args) : null;
    const emailOutbox = name === 'fleet_email_outbox' ? parseFleetEmailOutboxArgs(args) : null;
    const emailOutboxAwait = name === 'fleet_email_outbox_await' ? parseFleetEmailOutboxAwaitArgs(args) : null;
    const emailOutboxBatchAwait = name === 'fleet_email_outbox_batch_await' ? parseFleetEmailOutboxBatchAwaitArgs(args) : null;
    const commsReadinessArgs = name === 'fleet_comms_readiness' ? parseFleetCommsReadinessArgs(args) : null;
    const channelsOverviewArgs = name === 'fleet_channels_overview' ? parseFleetChannelsOverviewArgs(args) : null;
    const commsInboxArgs = name === 'fleet_comms_inbox' ? parseFleetCommsInboxArgs(args) : null;
    const commsStatusArgs = name === 'fleet_comms_status' ? parseFleetCommsStatusArgs(args) : null;
    const commsThreadArgs = name === 'fleet_comms_thread' ? parseFleetCommsThreadArgs(args) : null;
    const ownerHistoryArgs = name === 'fleet_owner_history' ? parseFleetOwnerHistoryArgs(args) : null;
    const commsHealthArgs = name === 'fleet_comms_health' ? parseFleetCommsHealthArgs(args) : null;
    const emailDiagnosisArgs = name === 'fleet_email_diagnosis' ? parseFleetEmailDiagnosisArgs(args) : null;
    const gmailTriageLatestArgs = name === 'fleet_gmail_triage_latest' ? parseFleetGmailTriageLatestArgs(args) : null;
    const diskForecastArgs = name === 'fleet_disk_forecast' ? parseFleetDiskForecastArgs(args) : null;
    const gmailArchivePlanLatestArgs = name === 'fleet_gmail_archive_plan_latest' ? parseFleetGmailArchivePlanLatestArgs(args) : null;
    const imessagePathArgs = name === 'fleet_imessage_path' ? parseFleetImessagePathArgs(args) : null;
    const imessageAcks = name === 'fleet_imessage_acks' ? parseFleetImessageAcksArgs(args) : null;
    const imessageTasks = name === 'fleet_imessage_tasks' ? parseFleetImessageTasksArgs(args) : null;
    const slackEvidenceArgs = name === 'fleet_slack_evidence' ? parseFleetSlackEvidenceArgs(args) : null;
    const ciResumeInputs = name === 'fleet_ci_resume_inputs' ? parseFleetCiResumeInputsArgs(args) : null;
    const ciReceiptAwait = name === 'fleet_ci_receipt_await' ? parseFleetCiReceiptAwaitArgs(args) : null;
    const ciReceiptAwaitBatch = name === 'fleet_ci_receipt_await_batch' ? parseFleetCiReceiptAwaitBatchArgs(args) : null;
    const orchestrationRead = name === 'fleet_orchestration_read' ? parseFleetOrchestrationReadArgs(args) : null;
    const intentRead = name === 'fleet_intent_read' ? parseFleetIntentReadArgs(args) : null;
    const selfTickLastArgs = name === 'fleet_self_tick_last' ? parseFleetSelfTickLastArgs(args) : null;
    const unfedArgs = name === 'fleet_unfed' ? parseFleetUnfedArgs(args) : null;
    const sessionHandoffArgs = name === 'fleet_session_handoff' ? parseFleetSessionHandoffArgs(args) : null;
    const peerLedgerArgs = name === 'fleet_peer_ledger' ? parseFleetPeerLedgerArgs(args) : null;
    const recheckArgs = name === 'fleet_recheck' ? parseFleetRecheckArgs(args) : null;
    const recheckHistory = name === 'fleet_recheck_history' ? parseFleetRecheckHistoryArgs(args) : null;
    const releaseCandidate = name === 'fleet_release_candidate' ? parseFleetReleaseCandidateArgs(args) : null;
    if (name === 'fleet_empties' ? Object.keys(args).some(key => key !== 'hours') || typeof emptyHours !== 'number' || !Number.isFinite(emptyHours) || emptyHours <= 0 || emptyHours > 2160 :
        name === 'fleet_review_pick' ? reviewPick === null :
        name === 'fleet_order_state' ? orderState === null :
        name === 'fleet_work_board' ? workBoard === null :
        name === 'fleet_orchestration_read' ? orchestrationRead === null :
        name === 'fleet_intent_read' ? intentRead === null :
        name === 'fleet_self_tick_last' ? selfTickLastArgs === null :
        name === 'fleet_unfed' ? unfedArgs === null :
        name === 'fleet_runtime' ? parseFleetRuntimeArgs(args) === null :
        name === 'fleet_peer_ledger' ? peerLedgerArgs === null :
        name === 'fleet_session_handoff' ? sessionHandoffArgs === null :
        name === 'fleet_surface_owner' ? surfaceOwner === null :
        name === 'fleet_claim_execution' ? claimExecution === null :
        name === 'fleet_recheck' ? recheckArgs === null :
        name === 'fleet_recheck_history' ? recheckHistory === null :
        name === 'fleet_bridge_check' ? parseFleetBridgeCheckArgs(args) === null :
        name === 'fleet_release_candidate' ? releaseCandidate === null :
        name === 'fleet_staging_inventory' ? fleetStagingInventory === null :
        name === 'fleet_staging_inventory_retry' ? retry === null :
        name === 'fleet_staging_inventory_batch' ? stagingRoots === null :
        name === 'fleet_ci_receipt_await_batch' ? ciReceiptAwaitBatch === null :
        name === 'fleet_ci_receipt_await' ? ciReceiptAwait === null :
        name === 'fleet_ci_resume_inputs' ? ciResumeInputs === null :
        name === 'fleet_comms_readiness' ? commsReadinessArgs === null :
        name === 'fleet_channels_overview' ? channelsOverviewArgs === null :
        name === 'fleet_imessage_path' ? imessagePathArgs === null :
        name === 'fleet_imessage_acks' ? imessageAcks === null :
        name === 'fleet_imessage_tasks' ? imessageTasks === null :
        name === 'fleet_slack_evidence' ? slackEvidenceArgs === null :
        name === 'fleet_email_diagnosis' ? emailDiagnosisArgs === null :
        name === 'fleet_gmail_triage_latest' ? gmailTriageLatestArgs === null :
        name === 'fleet_disk_forecast' ? diskForecastArgs === null :
        name === 'fleet_gmail_archive_plan_latest' ? gmailArchivePlanLatestArgs === null :
        name === 'fleet_comms_inbox' ? commsInboxArgs === null :
        name === 'fleet_comms_status' ? commsStatusArgs === null :
        name === 'fleet_comms_thread' ? commsThreadArgs === null :
        name === 'fleet_owner_history' ? ownerHistoryArgs === null :
        name === 'fleet_comms_health' ? commsHealthArgs === null :
        name === 'fleet_email_outbox_batch_await' ? emailOutboxBatchAwait === null :
        name === 'fleet_email_outbox_await' ? emailOutboxAwait === null :
        name === 'fleet_email_outbox' ? emailOutbox === null :
        name === 'fleet_job_precheck_batch' ? jobPrecheckBatch === null :
        name === 'fleet_job_precheck' ? jobPrecheck === null :
        name === 'fleet_path_cochanges' ? pathCochanges === null :
        name === 'fleet_path_history' ? pathHistory === null :
        name === 'fleet_job_history_batch' ? jobHistoryBatch === null :
        name === 'fleet_job_overlap' ? jobOverlap === null :
        name === 'fleet_job_current_batch' ? jobCurrentBatch === null :
        name === 'fleet_job_current' ? jobCurrent === null :
        name === 'fleet_job_current_snapshot' ? jobCurrentSnapshot === null :
        name === 'fleet_job_patch' ? jobPatchArgs === null :
        name === 'fleet_job_history' ? jobHistory === null :
        name === 'fleet_reset_group_await' ? resetGroupAwait === null :
        name === 'fleet_reset_await' ? resetAwait === null :
        name === 'fleet_reset_release_await' ? resetReleaseAwait === null :
        name === 'fleet_reset_follow' ? resetFollow === null :
        name === 'fleet_bus_inbox' ? inbox === null :
        name === 'fleet_agent_inbox' ? agentInboxArgs === null :
        name === 'fleet_agent_work' ? agentWorkArgs === null :
        name === 'fleet_agent_wakes' ? agentWakesArgs === null :
        name === 'fleet_agent_messages' ? agentMessagesArgs === null :
        name === 'fleet_agent_channels' ? agentChannelsArgs === null :
        name === 'fleet_agent_identity' ? agentIdentityArgs === null :
        name === 'fleet_agent_conversations' ? agentConversationsArgs === null :
        name === 'fleet_agent_roster' ? agentRosterArgs === null :
        name === 'fleet_bus_channel' ? busChannelArgs === null :
        name === 'fleet_bus_show' ? busShowArgs === null :
        name === 'fleet_bus_thread' ? busThreadArgs === null :
        name === 'fleet_bus_status' ? busStatusArgs === null :
        name === 'fleet_bus_claims' ? busClaimsArgs === null :
        name === 'fleet_bus_board' ? busBoardArgs === null :
        name === 'fleet_seat_handoffs' ? seatHandoffsArgs === null :
        name === 'fleet_bot_seats' ? botSeatsArgs === null :
        name === 'fleet_work_feed' ? workFeedArgs === null :
        name === 'fleet_coordination_returns' ? coordinationReturnsArgs === null :
        name === 'fleet_reset_history' ? history === null :
        name === 'fleet_bus_hops' ? busHopsArgs === null :
        Object.keys(args).some(key => !limited || key !== 'limit') ||
        (limited && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maxLimit)) ||
        args['limit'] === null) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid fleet tool arguments.');
    }
    try {
      const value = name === 'fleet_staging_inventory' ? await (readers.stagingInventory ?? readFleetStagingInventory)(fleetStagingInventory as FleetStagingInventoryArgs)
        : name === 'fleet_staging_inventory_retry' ? retry :
        name === 'fleet_staging_inventory_batch' ? await readStagingBatch(stagingRoots as string[], readers.stagingScanner, extra.signal)
        : name === 'fleet_status' ? await readers.status()
        : name === 'fleet_empties' ? await (readers.empties ?? readFleetEmpties)(emptyHours as number)
        : name === 'fleet_loop' ? await readers.loop(limit as number)
        : name === 'fleet_bus_hops' ? await (readers.bus ?? readFleetBusHops)(busHopsArgs as FleetBusHopsArgs)
        : name === 'fleet_host_runs' ? await (readers.hostRuns ?? readFleetRunsDirState)()
        : name === 'fleet_coordination_claims' ? readFleetCoordinationClaims()
        : name === 'fleet_coordination_returns' ? await (readers.coordinationReturns ?? readFleetCoordinationReturns)(coordinationReturnsArgs as FleetCoordinationReturnsArgs)
        : name === 'fleet_runtime' ? await (readers.runtime ?? readFleetRuntime)()
        : name === 'fleet_peer_ledger' ? (readers.peerLedger ?? readFleetPeerLedger)(peerLedgerArgs as FleetPeerLedgerArgs)
        : name === 'fleet_session_handoff' ? (readers.sessionHandoff ?? readFleetSessionHandoff)(sessionHandoffArgs!)
        : name === 'fleet_surface_owner' ? await (readers.surfaceOwner ?? readFleetSurfaceOwner)(surfaceOwner!.surface)
        : name === 'fleet_claim_execution' ? await (readers.claimExecution ?? readFleetClaimExecution)()
        : name === 'fleet_runtime_identity' ? await (readers.runtimeIdentity ?? readFleetRuntimeIdentity)()
        : name === 'fleet_channel_health' ? await readFleetChannelHealth(readers.channelHealth)
        : name === 'fleet_channels_overview' ? await (readers.channelsOverview ?? readFleetChannelsOverview)()
        : name === 'fleet_tailnet_peers' ? await readFleetTailnetPeers(readers.tailnetPeers)
        : name === 'fleet_pool_reach' ? await readFleetPoolReach(readers.poolReach)
        : name === 'fleet_review_pick' ? await (readers.reviewPick ?? readFleetReviewPick)(reviewPick as FleetReviewPickArgs)
        : name === 'fleet_order_state' ? await (readers.orderState ?? readFleetOrderState)(orderState as FleetOrderStateArgs)
        : name === 'fleet_claim_notices' ? await readFleetClaimNotices(readers.claimNotices)
        : name === 'fleet_slack_replies' ? await readFleetSlackReplies(readers.slackReplies)
        : name === 'fleet_lanes' ? await (readers.lanes ?? readFleetLanes)()
        : name === 'fleet_unfed' ? await (readers.unfed ?? readFleetUnfed)(unfedArgs as FleetUnfedArgs)
        : name === 'fleet_self_tick_last' ? await (readers.selfTickLast ?? (() => readFleetSelfTickLast()))()
        : name === 'fleet_recheck' ? await (readers.recheck ?? (() => readFleetRecheckTool()))()
        : name === 'fleet_recheck_history' ? await (readers.recheckHistory ?? readFleetRecheckHistoryTool)(recheckHistory as FleetRecheckHistoryArgs)
        : name === 'fleet_bridge_check' ? await (readers.bridgeCheck ?? readFleetBridgeCheck)()
        : name === 'fleet_usage_resets' ? await (readers.usageResets ?? readFleetUsageResets)()
        : name === 'fleet_reset_group_await' ? await (readers.resetGroupAwait ?? readFleetResetGroupAwait)(resetGroupAwait as FleetResetGroupAwaitArgs)
        : name === 'fleet_reset_await' ? await (readers.resetAwait ?? readFleetResetAwait)(resetAwait as FleetResetAwaitArgs)
        : name === 'fleet_reset_release_await' ? await (readers.resetReleaseAwait ?? readFleetResetReleaseAwait)(resetReleaseAwait as FleetResetReleaseAwaitArgs)
        : name === 'fleet_reset_follow' ? await (readers.resetFollow ?? readFleetResetFollow)(resetFollow as FleetResetFollowArgs)
        : name === 'fleet_reset_history' ? await (readers.resetHistory ?? readFleetResetHistory)(history as FleetResetHistoryArgs)
        : name === 'fleet_path_cochanges' ? await (readers.pathCochanges ?? readFleetPathCochanges)(pathCochanges as FleetPathCochangesArgs)
        : name === 'fleet_path_history' ? await (readers.pathHistory ?? readFleetPathHistory)(pathHistory as FleetPathHistoryArgs)
        : name === 'fleet_job_history' ? await (readers.jobHistory ?? readFleetJobHistory)(jobHistory as FleetJobHistoryArgs)
        : name === 'fleet_job_history_batch' ? await (readers.jobHistoryBatch ?? readFleetJobHistoryBatch)(jobHistoryBatch as FleetJobHistoryBatchArgs)
        : name === 'fleet_job_overlap' ? await (readers.jobOverlap ?? readFleetJobOverlap)(jobOverlap as FleetJobOverlapArgs)
        : name === 'fleet_job_current_batch' ? await (readers.jobCurrentBatch ?? readFleetJobCurrentBatch)(jobCurrentBatch as FleetJobCurrentBatchArgs)
        : name === 'fleet_job_current' ? await (readers.jobCurrent ?? readFleetJobCurrent)(jobCurrent as FleetJobCurrentArgs)
        : name === 'fleet_job_current_snapshot' ? await (readers.jobCurrentSnapshot ?? readFleetJobCurrentSnapshot)(jobCurrentSnapshot as FleetJobCurrentSnapshotArgs)
        : name === 'fleet_job_patch' ? await (readers.jobPatch ?? readFleetJobPatch)(jobPatchArgs as FleetJobPatchArgs)
        : name === 'fleet_job_precheck_batch' ? await (readers.jobPrecheckBatch ?? readFleetJobPrecheckBatch)(jobPrecheckBatch as FleetJobPrecheckBatchArgs)
        : name === 'fleet_job_precheck' ? await (readers.jobPrecheck ?? readFleetJobPrecheck)(jobPrecheck as FleetJobPrecheckArgs)
        : name === 'fleet_main_health' ? await (readers.mainHealth ?? readFleetMainHealthTool)()
        : name === 'fleet_waste_risk' ? await (readers.wasteRisk ?? readFleetWasteRiskTool)()
        : name === 'fleet_kept' ? await (readers.kept ?? readFleetKeptTool)()
        : name === 'fleet_trim' ? await (readers.trim ?? readFleetTrimTool)()
        : name === 'fleet_email_outbox_batch_await' ? await (readers.emailOutboxBatchAwait ?? readFleetEmailOutboxBatchAwait)(emailOutboxBatchAwait as FleetEmailOutboxBatchAwaitArgs, extra.signal)
        : name === 'fleet_email_outbox_await' ? await (readers.emailOutboxAwait ?? readFleetEmailOutboxAwait)(emailOutboxAwait as FleetEmailOutboxAwaitArgs, extra.signal)
        : name === 'fleet_email_outbox' ? await (readers.emailOutbox ?? readFleetEmailOutbox)(emailOutbox as FleetEmailOutboxArgs)
        : name === 'fleet_comms_readiness' ? await (readers.commsReadiness ?? readFleetCommsReadiness)()
        : name === 'fleet_email_diagnosis' ? await (readers.emailDiagnosis ?? readFleetEmailDiagnosis)()
        : name === 'fleet_gmail_triage_latest' ? await (readers.gmailTriageLatest ?? (async () => readFleetGmailTriageLatest()))()
        : name === 'fleet_disk_forecast' ? await (readers.diskForecast ?? readFleetDiskForecast)()
        : name === 'fleet_gmail_archive_plan_latest' ? await (readers.gmailArchivePlanLatest ?? (async (a: FleetGmailArchivePlanLatestArgs) => readFleetGmailArchivePlanLatest(a)))(gmailArchivePlanLatestArgs as FleetGmailArchivePlanLatestArgs)
        : name === 'fleet_comms_inbox' ? await (readers.commsInbox ?? readFleetCommsInbox)(commsInboxArgs as FleetCommsInboxArgs)
        : name === 'fleet_comms_status' ? await (readers.commsStatus ?? readFleetCommsStatus)()
        : name === 'fleet_comms_thread' ? await (readers.commsThread ?? readFleetCommsThread)(commsThreadArgs as FleetCommsThreadArgs)
        : name === 'fleet_owner_history' ? await (readers.ownerHistory ?? readFleetOwnerHistory)(ownerHistoryArgs as FleetOwnerHistoryArgs)
        : name === 'fleet_comms_health' ? await (readers.commsHealth ?? readFleetCommsHealth)()
        : name === 'fleet_imessage_path' ? await (readers.imessagePath ?? readFleetImessagePath)()
        : name === 'fleet_imessage_acks' ? await (readers.imessageAcks ?? readFleetImessageAcks)(imessageAcks as FleetImessageAcksArgs)
        : name === 'fleet_imessage_tasks' ? await (readers.imessageTasks ?? readFleetImessageTasks)(imessageTasks as FleetImessageTasksArgs)
        : name === 'fleet_slack_evidence' ? await (readers.slackEvidence ?? readFleetSlackEvidence)(slackEvidenceArgs as FleetSlackEvidenceArgs)
        : name === 'fleet_slack_status' ? await readFleetSlackStatus(readers.slackStatus)
        : name === 'fleet_ci_resume_inputs' ? await (readers.ciResumeInputs ?? readFleetCiResumeInputs)(ciResumeInputs as FleetCiResumeInputsArgs)
        : name === 'fleet_ci_receipt_await' ? await (readers.ciReceiptAwait ?? readFleetCiReceiptAwait)(ciReceiptAwait as FleetCiReceiptAwaitArgs, extra.signal)
        : name === 'fleet_ci_receipt_await_batch' ? await (readers.ciReceiptAwaitBatch ?? readFleetCiReceiptAwaitBatch)(ciReceiptAwaitBatch as FleetCiReceiptAwaitBatchArgs, extra.signal)
        : name === 'fleet_orchestration_read' ? await (readers.orchestrationRead ?? readFleetOrchestration)(orchestrationRead as FleetOrchestrationReadArgs)
        : name === 'fleet_intent_read' ? await (readers.intentRead ?? readFleetIntent)(intentRead as FleetIntentReadArgs)
        : name === 'fleet_release_candidate' ? await (readers.releaseCandidate ?? readFleetReleaseCandidate)(releaseCandidate as FleetReleaseCandidateArgs)
        : name === 'fleet_work_board' ? await (readers.workBoard ?? readFleetWorkBoard)(workBoard as FleetWorkBoardArgs)
        : name === 'fleet_work_feed' ? await (readers.workFeed ?? readFleetWorkFeed)(workFeedArgs as FleetWorkFeedArgs)
        : name === 'fleet_agent_inbox' ? await (readers.agentInbox ?? readFleetAgentInbox)(agentInboxArgs as FleetAgentInboxArgs)
        : name === 'fleet_agent_work' ? await (readers.agentWork ?? readFleetAgentWork)(agentWorkArgs as FleetAgentWorkArgs)
        : name === 'fleet_agent_wakes' ? await (readers.agentWakes ?? readFleetAgentWakes)(agentWakesArgs as FleetAgentWakesArgs)
        : name === 'fleet_agent_messages' ? await (readers.agentMessages ?? readFleetAgentMessages)(agentMessagesArgs as FleetAgentMessagesArgs)
        : name === 'fleet_agent_channels' ? await (readers.agentChannels ?? readFleetAgentChannels)(agentChannelsArgs as FleetAgentChannelsArgs)
        : name === 'fleet_agent_identity' ? await (readers.agentIdentity ?? readFleetAgentIdentity)(agentIdentityArgs as FleetAgentIdentityArgs)
        : name === 'fleet_agent_conversations' ? await (readers.agentConversations ?? readFleetAgentConversations)(agentConversationsArgs as FleetAgentConversationsArgs)
        : name === 'fleet_agent_roster' ? await (readers.agentRoster ?? readFleetAgentRoster)()
        : name === 'fleet_bus_channel' ? await (readers.busChannel ?? readFleetBusChannel)(busChannelArgs as FleetBusChannelArgs)
        : name === 'fleet_bus_show' ? await (readers.busShow ?? readFleetBusShow)(busShowArgs as FleetBusShowArgs)
        : name === 'fleet_bus_thread' ? await (readers.busThread ?? readFleetBusThread)(busThreadArgs as FleetBusThreadArgs)
        : name === 'fleet_bus_status' ? await (readers.busStatus ?? readFleetBusStatus)()
        : name === 'fleet_bus_claims' ? await (readers.busClaims ?? readFleetBusClaims)(busClaimsArgs as FleetBusClaimsArgs)
        : name === 'fleet_bus_board' ? await (readers.busBoard ?? readFleetBusBoard)(busBoardArgs as FleetBusBoardArgs)
        : name === 'fleet_seat_handoffs' ? await (readers.seatHandoffs ?? readFleetSeatHandoffs)()
        : name === 'fleet_bot_seats' ? await (readers.botSeats ?? readFleetBotSeats)()
        : await (readers.busInbox ?? readFleetBusInbox)(inbox as FleetBusInboxArgs);
      // Scrub values before serialization: redaction regexes operate on prose
      // and may consume JSON quotes if applied to already serialized bytes.
      const text = JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'string' ? scrubPrivateText(item, { emails: true }) : item,
      );
      // Never slice JSON: oversized observations fail explicitly and remain valid MCP.
      if (Buffer.byteLength(text, 'utf8') > MAX_FLEET_OUTPUT_BYTES) {
        return { isError: true, content: [{ type: 'text', text: 'Fleet observation exceeds the output limit; request a smaller limit.' }] };
      }
      return { content: [{ type: 'text', text }] };
    } catch {
      // Source exceptions may contain config values, tokens, or machine paths.
      return { isError: true, content: [{ type: 'text', text: 'Fleet observation unavailable; inspect local configuration and fleet stores.' }] };
    }
  });
  return server;
}

export async function startFleetServer(): Promise<void> {
  await createFleetServer().connect(new StdioServerTransport());
}
