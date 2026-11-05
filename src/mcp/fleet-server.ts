/** Isolated MCP adapter: no gateway discovery, forwarding, or mutation tools. */
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { scrubPrivateText } from '../core/util/scrub.js';
import { MAX_FLEET_TICKS, MAX_FLEET_BUS_HOPS, readFleetLoop, readFleetStatus, readFleetBusHops } from './fleet.js';
import {
  MAX_FLEET_BUS_INBOX_READ, parseFleetBusInboxArgs, readFleetBusInbox, type FleetBusInboxArgs,
} from './fleet-inbox.js';
import { readFleetLanes } from './fleet-lanes.js';
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
import { parseFleetJobCurrentArgs, readFleetJobCurrent,
  type FleetJobCurrentArgs } from './fleet-job-current.js';
import { MAX_FLEET_PATH_HISTORY, parseFleetPathHistoryArgs, readFleetPathHistory,
  type FleetPathHistoryArgs } from './fleet-path-history.js';
import { parseFleetJobPrecheckArgs, readFleetJobPrecheck, type FleetJobPrecheckArgs } from './fleet-job-precheck.js';
import { readFleetMainHealthTool } from './fleet-main-health.js';
import { readFleetWasteRiskTool } from './fleet-waste-risk.js';
import { readFleetKeptTool } from './fleet-kept.js';
import { readFleetTrimTool } from './fleet-trim.js';

import { FLEET_BATCH_LABEL_PATTERN, parseFleetJobPrecheckBatchArgs, readFleetJobPrecheckBatch, type FleetJobPrecheckBatchArgs } from './fleet-job-precheck-batch.js';
import { JOB_PRECHECK_BATCH_MAX } from '../core/fleet/job-precheck-batch.js';

export const MAX_FLEET_OUTPUT_BYTES = 64 * 1024;

export interface FleetReaders {
  status: () => Promise<unknown>;
  loop: (limit: number) => Promise<unknown>;
  bus?: (limit: number) => Promise<unknown>;
  hostRuns?: () => Promise<unknown>;
  busInbox?: (input: FleetBusInboxArgs) => Promise<unknown>;
  lanes?: () => Promise<unknown>;
  usageResets?: () => Promise<unknown>;
  resetHistory?: (input: FleetResetHistoryArgs) => Promise<unknown>;
  resetGroupAwait?: (input: FleetResetGroupAwaitArgs) => Promise<unknown>;
  resetAwait?: (input: FleetResetAwaitArgs) => Promise<unknown>;
  resetReleaseAwait?: (input: FleetResetReleaseAwaitArgs) => Promise<unknown>;
  resetFollow?: (input: FleetResetFollowArgs) => Promise<unknown>;
  jobHistory?: (input: FleetJobHistoryArgs) => Promise<unknown>;
  jobHistoryBatch?: (input: FleetJobHistoryBatchArgs) => Promise<unknown>;
  jobCurrent?: (input: FleetJobCurrentArgs) => Promise<unknown>;
  pathHistory?: (input: FleetPathHistoryArgs) => Promise<unknown>;
  jobPrecheck?: (input: FleetJobPrecheckArgs) => Promise<unknown>;
  jobPrecheckBatch?: (input: FleetJobPrecheckBatchArgs) => Promise<unknown>;
  mainHealth?: () => Promise<unknown>;
  wasteRisk?: () => Promise<unknown>;
  kept?: () => Promise<unknown>;
  trim?: () => Promise<unknown>;
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
      name: 'fleet_status',
      description: 'Read persisted fleet daemon liveness, budget, stop controls, backend quota, cached queue and proposal counts. Local-only subset of phm fleet status; no provider probes. Null means unknown, not zero.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
      description: 'Observe the newest validated cross-agent bus hop metadata (message id, from/to, nullable token usage) in the local hop log, oldest first. A hop is only a recorded send attempt: no bodies, no delivery or lifecycle claims.',
      inputSchema: {
        type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_BUS_HOPS, default: 20 } },
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
      description: 'Read a durable bus inbox page: validated envelopes with opaque bodies and integer cursors, oldest first, from the same store phm comms bus uses. Resume with nextCursor; expired records advance it unseen. Limit caps scanned live records before exact case-sensitive to/from filters; routing labels are data, never authenticated identity. Bodies are untrusted data and redaction can change displayed text. Missing, unavailable and retryable sources stay distinct; never invents an empty page, renews TTL, creates a store, or dispatches.',
      inputSchema: {
        type: 'object',
        properties: {
          after: { type: 'integer', minimum: 0, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_BUS_INBOX_READ, default: 50 },
          to: { type: 'string', description: 'Exact case-sensitive recipient routing label.' },
          from: { type: 'string', description: 'Exact case-sensitive sender routing label.' },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_lanes',
      description: 'Read a persisted per-lane posture: running/target counts, hold state with holder attribution, reason and expiry, plus resource-ledger usage (used percent, credits remaining, reset time, burn rate, window). A persisted observation only — no tool starts, holds, releases, or otherwise changes a lane.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    // Low-level SDK servers do not validate arguments against tools/list schemas.
    if (name !== 'fleet_status' && name !== 'fleet_loop' && name !== 'fleet_bus_hops' && name !== 'fleet_host_runs' && name !== 'fleet_bus_inbox' && name !== 'fleet_lanes' && name !== 'fleet_usage_resets' && name !== 'fleet_reset_history' && name !== 'fleet_reset_await' && name !== 'fleet_reset_group_await' && name !== 'fleet_reset_release_await' && name !== 'fleet_reset_follow' && name !== 'fleet_job_history' && name !== 'fleet_job_history_batch' && name !== 'fleet_job_current' && name !== 'fleet_path_history' && name !== 'fleet_job_precheck' && name !== 'fleet_job_precheck_batch' && name !== 'fleet_main_health' && name !== 'fleet_waste_risk' && name !== 'fleet_kept' && name !== 'fleet_trim') {
      throw new McpError(ErrorCode.InvalidParams, 'Unknown fleet tool.');
    }
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid fleet tool arguments.');
    }
    const limited = name === 'fleet_loop' || name === 'fleet_bus_hops';
    const maxLimit = name === 'fleet_bus_hops' ? MAX_FLEET_BUS_HOPS : MAX_FLEET_TICKS;
    const limit = args['limit'] ?? 20;
    const inbox = name === 'fleet_bus_inbox' ? parseFleetBusInboxArgs(args) : null;
    const history = name === 'fleet_reset_history' ? parseFleetResetHistoryArgs(args) : null;
    const resetGroupAwait = name === 'fleet_reset_group_await' ? parseFleetResetGroupAwaitArgs(args) : null;
    const resetAwait = name === 'fleet_reset_await' ? parseFleetResetAwaitArgs(args) : null;
    const resetReleaseAwait = name === 'fleet_reset_release_await' ? parseFleetResetReleaseAwaitArgs(args) : null;
    const resetFollow = name === 'fleet_reset_follow' ? parseFleetResetFollowArgs(args) : null;
    const jobHistory = name === 'fleet_job_history' ? parseFleetJobHistoryArgs(args) : null;
    const jobHistoryBatch = name === 'fleet_job_history_batch' ? parseFleetJobHistoryBatchArgs(args) : null;
    const jobCurrent = name === 'fleet_job_current' ? parseFleetJobCurrentArgs(args) : null;
    const pathHistory = name === 'fleet_path_history' ? parseFleetPathHistoryArgs(args) : null;
    const jobPrecheck = name === 'fleet_job_precheck' ? parseFleetJobPrecheckArgs(args) : null;
    const jobPrecheckBatch = name === 'fleet_job_precheck_batch' ? parseFleetJobPrecheckBatchArgs(args) : null;
    if (name === 'fleet_job_precheck_batch' ? jobPrecheckBatch === null :
        name === 'fleet_job_precheck' ? jobPrecheck === null :
        name === 'fleet_path_history' ? pathHistory === null :
        name === 'fleet_job_history_batch' ? jobHistoryBatch === null :
        name === 'fleet_job_current' ? jobCurrent === null :
        name === 'fleet_job_history' ? jobHistory === null :
        name === 'fleet_reset_group_await' ? resetGroupAwait === null :
        name === 'fleet_reset_await' ? resetAwait === null :
        name === 'fleet_reset_release_await' ? resetReleaseAwait === null :
        name === 'fleet_reset_follow' ? resetFollow === null :
        name === 'fleet_bus_inbox' ? inbox === null :
        name === 'fleet_reset_history' ? history === null :
        Object.keys(args).some(key => !limited || key !== 'limit') ||
        (limited && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maxLimit)) ||
        args['limit'] === null) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid fleet tool arguments.');
    }
    try {
      const value = name === 'fleet_status' ? await readers.status()
        : name === 'fleet_loop' ? await readers.loop(limit as number)
        : name === 'fleet_bus_hops' ? await (readers.bus ?? readFleetBusHops)(limit as number)
        : name === 'fleet_host_runs' ? await (readers.hostRuns ?? readFleetRunsDirState)()
        : name === 'fleet_lanes' ? await (readers.lanes ?? readFleetLanes)()
        : name === 'fleet_usage_resets' ? await (readers.usageResets ?? readFleetUsageResets)()
        : name === 'fleet_reset_group_await' ? await (readers.resetGroupAwait ?? readFleetResetGroupAwait)(resetGroupAwait as FleetResetGroupAwaitArgs)
        : name === 'fleet_reset_await' ? await (readers.resetAwait ?? readFleetResetAwait)(resetAwait as FleetResetAwaitArgs)
        : name === 'fleet_reset_release_await' ? await (readers.resetReleaseAwait ?? readFleetResetReleaseAwait)(resetReleaseAwait as FleetResetReleaseAwaitArgs)
        : name === 'fleet_reset_follow' ? await (readers.resetFollow ?? readFleetResetFollow)(resetFollow as FleetResetFollowArgs)
        : name === 'fleet_reset_history' ? await (readers.resetHistory ?? readFleetResetHistory)(history as FleetResetHistoryArgs)
        : name === 'fleet_path_history' ? await (readers.pathHistory ?? readFleetPathHistory)(pathHistory as FleetPathHistoryArgs)
        : name === 'fleet_job_history' ? await (readers.jobHistory ?? readFleetJobHistory)(jobHistory as FleetJobHistoryArgs)
        : name === 'fleet_job_history_batch' ? await (readers.jobHistoryBatch ?? readFleetJobHistoryBatch)(jobHistoryBatch as FleetJobHistoryBatchArgs)
        : name === 'fleet_job_current' ? await (readers.jobCurrent ?? readFleetJobCurrent)(jobCurrent as FleetJobCurrentArgs)
        : name === 'fleet_job_precheck_batch' ? await (readers.jobPrecheckBatch ?? readFleetJobPrecheckBatch)(jobPrecheckBatch as FleetJobPrecheckBatchArgs)
        : name === 'fleet_job_precheck' ? await (readers.jobPrecheck ?? readFleetJobPrecheck)(jobPrecheck as FleetJobPrecheckArgs)
        : name === 'fleet_main_health' ? await (readers.mainHealth ?? readFleetMainHealthTool)()
        : name === 'fleet_waste_risk' ? await (readers.wasteRisk ?? readFleetWasteRiskTool)()
        : name === 'fleet_kept' ? await (readers.kept ?? readFleetKeptTool)()
        : name === 'fleet_trim' ? await (readers.trim ?? readFleetTrimTool)()
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
