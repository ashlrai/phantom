/**
 * fleet_imessage_tasks — read-only teammate task ledger evidence for the
 * isolated fleet MCP server, so a shell-free coordination agent can
 * distinguish an actual Dot/Instinct task reservation, its transport
 * receipt and any peer-reported result. It delegates to the same
 * listTeammateTasks collector the CLI uses (`phm fleet imessage-tasks
 * list`) at the server-owned runs root — never a second store, reader or
 * dispatcher.
 *
 * The collector's own projection still carries the internal envelope
 * token plus kind/repo/prRefs/metrics/settled, so this module re-projects
 * each row to exactly: job identity, peer/resource, state, claimKey,
 * timestamps, the sanitized transport receipt (rowid, sent, delivered,
 * error) and the peer-reported result (rowid, status, at, evidence).
 * Envelope token, scope, format, result summary, handles, message bodies
 * and filesystem paths never leave through this tool.
 *
 * Ledger presence is reported separately (present, missing, unavailable)
 * so a missing or corrupt store never poses as a healthy empty
 * assignment, and a throwing collector degrades to fixed unavailable
 * evidence — never raw exception text and never an invented empty page.
 * Task states are local ledger states verbatim: queued is never RUNNING,
 * a DONE result is peer-reported and unverified, and a sent receipt is
 * never delivery proof. The tool never sends, enqueues, dispatches,
 * claims, polls or writes anything.
 */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listTeammateTasks, type TeammateTaskOptions } from '../core/comms/imessage-teammate-tasks.js';
import { imessageStateDir } from '../core/integrations/imessage.js';
import { scrubSecrets } from '../core/util/scrub.js';

export const MAX_FLEET_IMESSAGE_TASKS = 100;
export const DEFAULT_FLEET_IMESSAGE_TASKS = 20;

/** Same job id shape the teammate-task envelope schema accepts. */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export type FleetImessageSourceState = 'ok' | 'unavailable';
export type FleetImessageLedgerState = 'present' | 'missing' | 'unavailable';

export interface FleetImessageTasksArgs {
  /** Optional exact jobId selector, applied before limit truncation. */
  jobId?: string;
  /** Cap on returned rows after filtering; the newest matches are kept. */
  limit: number;
}

export interface FleetImessageTaskReceipt {
  jobId: string;
  peer: string;
  /** Owning resource label such as imsg:dot — never a handle. */
  resource: string;
  /** Local ledger state verbatim: queued | sending | pending | replied | expired. */
  state: string;
  claimKey: string;
  createdAt: number;
  attemptedAt?: number;
  deadline: string;
  /** Sanitized transport receipt fields only; null before any attempt. */
  transportReceipt: { rowid: number; sent: boolean; delivered: boolean; error: number } | null;
  /** Peer-reported result evidence only; null until a reply is recorded. */
  result: { rowid: number; status: string; at: number; evidence: string } | null;
}

export interface FleetImessageTasksReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  limit: number;
  /** Echo of the exact selector; null when the read is unfiltered. */
  jobId: string | null;
  /** Selector outcome on a healthy read; null when unfiltered or unavailable. */
  matched: boolean | null;
  /** 'ok' once the shared collector ran; 'unavailable' when it could not. */
  sourceState: FleetImessageSourceState;
  /** Filesystem presence of teammate-tasks.json at the server-owned root. */
  ledgerState: FleetImessageLedgerState;
  /** Scope marker: local persisted evidence, peer results stay unverified. */
  coverage: 'local-evidence-only-peer-reported-results-unverified';
  /** Projected rows; null when the collector could not run. */
  tasks: FleetImessageTaskReceipt[] | null;
}

export interface FleetImessageTasksDeps {
  /** iMessage runs root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  /** Task collector; default listTeammateTasks (test seam). */
  listTasks?: (options: TeammateTaskOptions) => ReturnType<typeof listTeammateTasks>;
}

type ListedTask = ReturnType<typeof listTeammateTasks>['tasks'][number];

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Only
 * `jobId` (an exact envelope-shaped id) and `limit` are accepted; any
 * other key — including caller dir, root, cwd, path, config, send,
 * enqueue, poll or claim options — is an argument error rejected before
 * any filesystem read.
 */
export function parseFleetImessageTasksArgs(args: Record<string, unknown>): FleetImessageTasksArgs | null {
  const limit = args['limit'] ?? DEFAULT_FLEET_IMESSAGE_TASKS;
  const jobId = args['jobId'];
  if (Object.keys(args).some(key => key !== 'jobId' && key !== 'limit') ||
    args['jobId'] === null || args['limit'] === null ||
    jobId !== undefined && (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId) || scrubSecrets(jobId) !== jobId) ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_IMESSAGE_TASKS) return null;
  return { ...(jobId === undefined ? {} : { jobId: jobId as string }), limit };
}

/** Presence of the ledger file only — never its contents. */
function probeLedger(runsDir: string): FleetImessageLedgerState {
  try {
    lstatSync(join(imessageStateDir(runsDir), 'teammate-tasks.json'));
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}

/** Whitelist projection: the collector's token and private fields never cross. */
function projectTask(task: ListedTask): FleetImessageTaskReceipt {
  const receipt = task.receipt;
  const result = task.result;
  return {
    jobId: task.jobId,
    peer: task.peer,
    resource: task.resource,
    state: task.state,
    claimKey: task.claimKey,
    createdAt: task.createdAt,
    ...(task.attemptedAt === undefined ? {} : { attemptedAt: task.attemptedAt }),
    deadline: task.deadline,
    transportReceipt: receipt ? {
      rowid: receipt.rowid, sent: receipt.sent, delivered: receipt.delivered, error: receipt.error,
    } : null,
    result: result ? {
      rowid: result.rowid, status: result.status, at: result.at, evidence: result.evidence,
    } : null,
  };
}

/**
 * Reads listTeammateTasks at the server-owned runs root, filters by the
 * exact jobId selector first, then keeps the newest `limit` matches in
 * collector order. A missing ledger stays an honest empty page marked
 * ledgerState 'missing'; a throwing or malformed collector degrades to
 * sourceState 'unavailable' with null tasks — never raw exception text.
 */
export async function readFleetImessageTasks(
  input: FleetImessageTasksArgs,
  deps: FleetImessageTasksDeps = {},
): Promise<FleetImessageTasksReport> {
  const runsDir = deps.runsDir ?? join(homedir(), '.ashlr-runs');
  const base = {
    schemaVersion: 1 as const,
    snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    generatedAt: new Date().toISOString(),
    limit: input.limit,
    jobId: input.jobId ?? null,
    coverage: 'local-evidence-only-peer-reported-results-unverified' as const,
  };
  const ledgerState = probeLedger(runsDir);
  let tasks: ListedTask[];
  try {
    const collected = (deps.listTasks ?? listTeammateTasks)({ runsDir });
    if (!collected || !Array.isArray(collected.tasks)) throw new Error('invalid collector report');
    tasks = collected.tasks;
  } catch {
    return { ...base, sourceState: 'unavailable', ledgerState, matched: null, tasks: null };
  }
  const matchedTasks = input.jobId === undefined ? tasks : tasks.filter(task => task.jobId === input.jobId);
  return {
    ...base,
    sourceState: 'ok',
    ledgerState,
    matched: input.jobId === undefined ? null : matchedTasks.length > 0,
    tasks: matchedTasks.slice(-input.limit).map(projectTask),
  };
}
