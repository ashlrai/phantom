/** Isolated MCP adapter: no gateway discovery, forwarding, or mutation tools. */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard, WORK_BOARD_DEFAULT_LIMIT, WORK_BOARD_MAX_LIMIT } from '../core/comms/work-board.js';
import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { buildSlackBridgeStatus } from '../core/agents/slack-status.js';
import { defaultTailnetPeersDeps, readTailnetPeers } from '../core/fleet/tailnet-peers.js';
import { defaultPoolReachDeps, readPoolReach } from '../core/fleet/pool-reach.js';
import { readChannelHealth } from '../core/fleet/channel-health.js';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity, sanitizeIdentityText } from '../core/fleet/runtime-identity.js';
import { scrubPrivateText } from '../core/util/scrub.js';
import { MAX_FLEET_TICKS, MAX_FLEET_BUS_HOPS, readFleetLoop, readFleetStatus, readFleetBusHops } from './fleet.js';
import {
  MAX_FLEET_BUS_INBOX_READ, parseFleetBusInboxArgs, readFleetBusInbox, type FleetBusInboxArgs,
} from './fleet-inbox.js';
import { readFleetLanes } from './fleet-lanes.js';
import { parseFleetSelfTickLastArgs, readFleetSelfTickLast } from './fleet-self-tick.js';
import { MAX_FLEET_RECHECK_HISTORY, DEFAULT_FLEET_RECHECK_HISTORY, parseFleetRecheckArgs, parseFleetRecheckHistoryArgs,
  readFleetRecheckTool, readFleetRecheckHistoryTool, type FleetRecheckHistoryArgs } from './fleet-recheck.js';
import { readFleetUsageResets } from './fleet-usage-resets.js';
import {
  MAX_FLEET_RESET_HISTORY, parseFleetResetHistoryArgs, readFleetResetHistory, type FleetResetHistoryArgs,
} from './fleet-reset-history.js';

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
import { parseFleetCommsReadinessArgs, readFleetCommsReadiness } from '../core/mcp/fleet-comms-readiness.js';
import { MAX_FLEET_IMESSAGE_ACKS, parseFleetImessageAcksArgs, parseFleetImessagePathArgs,
  readFleetImessageAcks, readFleetImessagePath, type FleetImessageAcksArgs } from './fleet-imessage-evidence.js';

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
}

const WORK_BOARD_ARG_KEYS = new Set(['limit', 'thread']);

/** Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so unknown keys — including any caller `root` —,
 * out-of-range limits and oversized or non-string threads are rejected
 * before the store is touched. The board always reads the server-owned
 * default fleet root. */
function parseFleetWorkBoardArgs(args: Record<string, unknown>): FleetWorkBoardArgs | null {
  const limit = args['limit'] ?? WORK_BOARD_DEFAULT_LIMIT, thread = args['thread'];
  if (Object.keys(args).some(key => !WORK_BOARD_ARG_KEYS.has(key)) ||
    args['limit'] === null || args['thread'] === null ||
    typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > WORK_BOARD_MAX_LIMIT ||
    thread !== undefined && (typeof thread !== 'string' || thread.length > 512)) return null;
  return { limit, thread: thread as string | undefined };
}

/** One bounded board read through the canonical listWorkBoard listing — the
 * same classifier as `ashlr fleet work-board`, never a second one — with the
 * invocation clock stamped as `asOf`. */
async function readFleetWorkBoard(input: FleetWorkBoardArgs) {
  const now = Date.now();
  const board = listWorkBoard({ root: join(ashlrHome(), 'fleet'), now, limit: input.limit, channelRef: input.thread });
  return { ...board, asOf: new Date(now).toISOString() };
}

/** Same bound as the verse comms-status API uses for the bridge health read. */
const CHANNEL_HEALTH_TIMEOUT_MS = 5_000;
const SLACK_REPLIES_TIMEOUT_MS = 5_000;

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
  /** Pool reachability join, sanitized error messages (reader never throws; deps are fixed, no caller input). */
  const readFleetPoolReach = (
    read: () => Promise<unknown> = async () => {
