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
import {
  listTeammateTasks, teammateQueueJobMatchesIdentity, teammateTaskLedgerMatch, teammateTaskQueueIdentities,
  TEAMMATE_TASK_KINDS, TEAMMATE_TASK_PEERS, TEAMMATE_TASK_STATES,
  type TeammateTaskKind, type TeammateTaskOptions, type TeammateTaskPeer, type TeammateTaskState,
} from '../core/comms/imessage-teammate-tasks.js';
import { imessageStateDir } from '../core/integrations/imessage.js';
import { QueueStore } from '../core/queue/store.js';
import type { QueueJob } from '../core/queue/schema.js';
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
  /** Optional exact peer selector (dot|instinct), ANDed with the others. */
  peer?: TeammateTaskPeer;
  /** Optional exact ledger-state selector, ANDed with the others. */
  state?: TeammateTaskState;
  /** Optional exact work-kind selector, ANDed with the others. */
  kind?: TeammateTaskKind;
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
  /** Binding is independent of ledger state; finished is historical, never an active assignment. */
  queueBinding: 'bound' | 'missing' | 'conflicting' | 'unavailable';
  queueClaim: 'active' | 'finished' | null;
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
  /** Echo of the exact jobId selector; null when that dimension is unfiltered. */
  jobId: string | null;
  /** Echo of each supplied enum selector; absent when that dimension is unfiltered, so an
   * unfiltered report never carries a `kind` key (kind stays off the row projection). */
  peer?: TeammateTaskPeer;
  state?: TeammateTaskState;
  kind?: TeammateTaskKind;
  /** Selector outcome on a healthy read; null when unfiltered or unavailable. */
  matched: boolean | null;
  /** 'ok' only for a healthy collector report; otherwise 'unavailable'. */
  sourceState: FleetImessageSourceState;
  /** Filesystem presence of teammate-tasks.json at the server-owned root. */
  ledgerState: FleetImessageLedgerState;
  queueState: 'ok' | 'unavailable';
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
  /** Reserved-identity index; default teammateTaskQueueIdentities (test seam). */
  listIdentities?: (options: TeammateTaskOptions) => ReturnType<typeof teammateTaskQueueIdentities>;
}

type ListedTask = ReturnType<typeof listTeammateTasks>['tasks'][number];

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Only
 * `jobId` (an exact envelope-shaped id), the bounded `peer`/`state`/`kind`
 * selectors and `limit` are accepted; any other key — including caller
 * dir, root, cwd, path, config, send, enqueue, poll or claim options — is
 * an argument error rejected before any filesystem read.
 */
export function parseFleetImessageTasksArgs(args: Record<string, unknown>): FleetImessageTasksArgs | null {
  const limit = args['limit'] ?? DEFAULT_FLEET_IMESSAGE_TASKS;
  const jobId = args['jobId'];
  const peer = args['peer'];
  const state = args['state'];
  const kind = args['kind'];
  const member = (value: unknown, allowed: readonly string[]) =>
    value === undefined || typeof value === 'string' && (allowed as readonly string[]).includes(value);
  if (Object.keys(args).some(key => !['jobId', 'peer', 'state', 'kind', 'limit'].includes(key)) ||
    args['jobId'] === null || args['peer'] === null || args['state'] === null || args['kind'] === null || args['limit'] === null ||
    jobId !== undefined && (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId) || scrubSecrets(jobId) !== jobId) ||
    !member(peer, TEAMMATE_TASK_PEERS) || !member(state, TEAMMATE_TASK_STATES) || !member(kind, TEAMMATE_TASK_KINDS) ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_IMESSAGE_TASKS) return null;
  return {
    ...(jobId === undefined ? {} : { jobId: jobId as string }),
    ...(peer === undefined ? {} : { peer: peer as TeammateTaskPeer }),
    ...(state === undefined ? {} : { state: state as TeammateTaskState }),
    ...(kind === undefined ? {} : { kind: kind as TeammateTaskKind }),
    limit,
  };
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
function projectTask(
  task: ListedTask,
  jobs: QueueJob[] | null,
  identities: ReturnType<typeof teammateTaskQueueIdentities> | null,
): FleetImessageTaskReceipt {
  const job = jobs?.find(candidate => candidate.id === task.jobId);
  const claim = job?.claims.at(-1);
  // Only consistent active or finished claims establish a binding; this does not prove execution or verification.
  const active = job?.status === 'CLAIMED' && claim && !claim.finishedAt;
  const finished = job && ['DONE', 'BLOCKED'].includes(job.status) && claim?.finishedAt;
  // The binding must prove the same identity the queue writer reserved — RESULT
  // token, owner, repo and scope — not merely a matching id/owner/repo row.
  const identity = identities?.get(task.jobId);
  const matches = job !== undefined && identity !== undefined && teammateQueueJobMatchesIdentity(job, identity);
  const binding = jobs === null || identities === null ? 'unavailable' : !job ? 'missing' :
    matches && (active || finished) ? 'bound' : 'conflicting';
  const receipt = task.receipt;
  const result = task.result;
  return {
    jobId: task.jobId,
    peer: task.peer,
    resource: task.resource,
    state: task.state,
    claimKey: task.claimKey,
    queueBinding: binding,
    queueClaim: binding === 'bound' ? (active ? 'active' : 'finished') : null,
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
    ...(input.peer === undefined ? {} : { peer: input.peer }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    coverage: 'local-evidence-only-peer-reported-results-unverified' as const,
  };
  const ledgerState = probeLedger(runsDir);
  let jobs: QueueJob[] | null = null;
  try { jobs = (await new QueueStore(join(runsDir, 'queue')).read()).jobs; } catch { /* Unknown is not an empty queue. */ }
  const queueState = jobs === null ? 'unavailable' as const : 'ok' as const;
  let tasks: ListedTask[];
  try {
    const collected = (deps.listTasks ?? listTeammateTasks)({ runsDir });
    if (!collected || collected.state !== 'healthy' || !Array.isArray(collected.tasks)) throw new Error('invalid collector report');
    tasks = collected.tasks;
  } catch {
    return { ...base, sourceState: 'unavailable', ledgerState, queueState, matched: null, tasks: null };
  }
  const filter = {
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    ...(input.peer === undefined ? {} : { peer: input.peer }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
  };
  const filtered = Object.keys(filter).length > 0;
  const matchedTasks = filtered ? tasks.filter(task => teammateTaskLedgerMatch(task, filter)) : tasks;
  let identities: ReturnType<typeof teammateTaskQueueIdentities> | null = null;
  try { identities = (deps.listIdentities ?? teammateTaskQueueIdentities)({ runsDir }); } catch { /* Unverifiable identity is not a match. */ }
  return {
    ...base,
    sourceState: 'ok',
    ledgerState,
    queueState,
    matched: filtered ? matchedTasks.length > 0 : null,
    tasks: matchedTasks.slice(-input.limit).map(task => projectTask(task, jobs, identities)),
  };
}
