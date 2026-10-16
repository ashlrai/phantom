import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { homedir, uptime as osUptime } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { EngineId } from './types.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from './fleet/local-store-lock.js';
import { isSafeExecutionIdentity } from './fleet/attempt-identity.js';
import { readStableRegularFile } from './util/stable-file-read.js';
import { assurePrivateStoragePath } from './util/private-storage.js';
import { writePrivateFileAtomically } from './util/private-file-write.js';
import { PID_REUSE_SLACK_MS, pidProvablyReusedSince, processStartedAtMs } from './daemon/pid-reuse-proof.js';

const TASK_GENERATION_DOMAIN = 'ashlr:simple-conductor-task-generation:v1';
const MAX_TASK_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TASKS = 10_000;
const MAX_TEXT_BYTES = 1_000_000;
const LEASE_DURATION_MS = 24 * 60 * 60_000;
// The conductor's longest retry window is 15 min * 2^8 = 64 h. A persisted
// deadline further ahead than these horizons was written under a skewed clock.
const MAX_RETRY_HORIZON_MS = 72 * 60 * 60_000;
// A live lease is written exactly LEASE_DURATION_MS ahead; allow an hour for a backward clock step.
const MAX_LEASE_HORIZON_MS = LEASE_DURATION_MS + 60 * 60_000;
const LEASE_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex',
  'hermes', 'kimi', 'nim', 'opencode', 'meta-muse', 'grok',
]);

export interface SimpleConductorDispatchLease {
  token: string;
  generationId: string;
  claimedAt: string;
  expiresAt: string;
  /** Pid of the claiming process. Absent on leases written before owner recording. */
  ownerPid?: number;
}

export interface TaskSpec {
  id: string;
  repo: string;
  engine?: EngineId;
  instruction: string;
  priority?: number;
  done?: boolean;
  dispatchedAt?: string;
  proposalId?: string;
  candidateProposalId?: string;
  lastError?: string;
  attempts?: number;
  retryAfter?: string;
  revision?: number;
  dispatchLease?: SimpleConductorDispatchLease;
}

export interface ClaimedSimpleConductorTask {
  task: TaskSpec;
  token: string;
  generationId: string;
  revision: number;
  rowDigest: string;
}

export type TaskStoreReadResult =
  | { ok: true; tasks: TaskSpec[] }
  | { ok: false; reason: string };

export type TaskClaimResult =
  | { ok: true; claim: ClaimedSimpleConductorTask }
  | { ok: false; reason: 'busy' | 'changed' | 'done' | 'cooling' | 'reconciliation-required' | 'unavailable'; detail: string };

export type TaskSettlement = {
  done?: boolean;
  proposalId?: string;
  candidateProposalId?: string;
  lastError?: string;
  retryAfter?: string;
};

export type TaskSettlementResult =
  | { ok: true; task: TaskSpec }
  | { ok: false; reason: 'changed' | 'unavailable'; detail: string };

function stateRoot(): string {
  return join(homedir(), '.ashlr');
}

export function simpleConductorTasksPath(): string {
  return join(stateRoot(), 'tasks.json');
}

function taskLockPath(): string {
  return join(stateRoot(), '.tasks.lock');
}

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function ensureStateRoot(): boolean {
  try {
    const root = stateRoot();
    let created = false;
    if (!existsSync(root)) {
      mkdirSync(root, { mode: 0o700 });
      created = true;
    }
    const before = lstatSync(root);
    if (before.isSymbolicLink() || !before.isDirectory() || !owned(before.uid)) return false;
    if (process.platform !== 'win32') chmodSync(root, 0o700);
    const assurance = assurePrivateStoragePath(
      root,
      'directory',
      created ? 'secure-created' : 'inspect-existing',
      {
        anchorPath: homedir(),
      },
    );
    if (!assurance.ok) return false;
    const after = lstatSync(root);
    return !after.isSymbolicLink() && after.isDirectory() && owned(after.uid) &&
      after.dev === before.dev && after.ino === before.ino;
  } catch {
    return false;
  }
}

function boundedString(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validLease(value: unknown): value is SimpleConductorDispatchLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  const keys = Object.keys(lease).sort().join(',');
  if (keys === 'claimedAt,expiresAt,generationId,ownerPid,token') {
    if (!Number.isSafeInteger(lease['ownerPid']) || Number(lease['ownerPid']) <= 0) return false;
  } else if (keys !== 'claimedAt,expiresAt,generationId,token') {
    return false;
  }
  return typeof lease['token'] === 'string' && LEASE_TOKEN_RE.test(lease['token']) &&
    typeof lease['generationId'] === 'string' && /^[a-f0-9]{64}$/.test(lease['generationId']) &&
    validIso(lease['claimedAt']) && validIso(lease['expiresAt']) &&
    Date.parse(lease['expiresAt']) > Date.parse(lease['claimedAt']);
}

function validTask(value: unknown): value is TaskSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  if (!isSafeExecutionIdentity(task['id']) || !boundedString(task['repo'], 16_384) ||
    !boundedString(task['instruction']) || task['instruction'].trim().length === 0) return false;
  if (!isAbsolute(task['repo']) || task['repo'].includes('\0')) return false;
  if (task['engine'] !== undefined &&
    (!boundedString(task['engine'], 160) || !ENGINE_IDS.has(task['engine'] as EngineId))) return false;
  if (task['priority'] !== undefined && !Number.isSafeInteger(task['priority'])) return false;
  if (task['done'] !== undefined && typeof task['done'] !== 'boolean') return false;
  if (task['attempts'] !== undefined &&
    (!Number.isSafeInteger(task['attempts']) || Number(task['attempts']) < 0)) return false;
  if (task['revision'] !== undefined &&
    (!Number.isSafeInteger(task['revision']) || Number(task['revision']) < 0)) return false;
  for (const key of ['dispatchedAt', 'retryAfter'] as const) {
    if (task[key] !== undefined && !validIso(task[key])) return false;
  }
  for (const key of ['proposalId', 'candidateProposalId'] as const) {
    if (task[key] !== undefined && !isSafeExecutionIdentity(task[key])) return false;
  }
  if (task['lastError'] !== undefined && !boundedString(task['lastError'], 16_384)) return false;
  return task['dispatchLease'] === undefined || validLease(task['dispatchLease']);
}

function parseTasks(raw: string): TaskStoreReadResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length > MAX_TASKS || !parsed.every(validTask)) {
      return { ok: false, reason: 'task store is not a bounded valid task array' };
    }
    const ids = new Set<string>();
    for (const task of parsed) {
      if (ids.has(task.id)) return { ok: false, reason: `task store contains duplicate id ${task.id}` };
      ids.add(task.id);
    }
    return { ok: true, tasks: parsed };
  } catch {
    return { ok: false, reason: 'task store contains malformed JSON' };
  }
}

function readTasksUnlocked(): TaskStoreReadResult {
  const path = simpleConductorTasksPath();
  if (!existsSync(path)) return { ok: true, tasks: [] };
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_TASK_FILE_BYTES,
    remainingBytes: MAX_TASK_FILE_BYTES,
  });
  if (!read.ok) return { ok: false, reason: `task store is unreadable: ${read.reason}` };
  return parseTasks(read.text);
}

function withTaskLock<T>(fn: () => T): T | null {
  if (!ensureStateRoot()) return null;
  const lock = acquireLocalStoreLock(taskLockPath(), 2_000, { anchorPath: homedir() });
  if (!lock) return null;
  try {
    return fn();
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function writeTasksUnlocked(tasks: TaskSpec[]): void {
  const encoded = `${JSON.stringify(tasks, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TASK_FILE_BYTES) {
    throw new Error('task store exceeds the maximum encoded size');
  }
  const target = simpleConductorTasksPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writePrivateFileAtomically(temporary, target, encoded, {
    anchorPath: homedir(),
    label: 'simple conductor task store',
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function simpleConductorTaskGenerationId(
  task: Pick<TaskSpec, 'id' | 'repo' | 'instruction' | 'engine'>,
): string {
  if (!isAbsolute(task.repo) || task.repo.includes('\0')) {
    throw new Error('task repository path is not canonicalizable');
  }
  const canonicalRepo = resolve(task.repo);
  return createHash('sha256').update(stableJson({
    domain: TASK_GENERATION_DOMAIN,
    id: task.id,
    repo: canonicalRepo,
    instruction: task.instruction,
    engine: task.engine ?? 'claude',
  })).digest('hex');
}

/** A future deadline beyond what this store ever writes cannot hold work after a clock correction. */
function pendingUntil(at: string, nowMs: number, horizonMs: number): boolean {
  const remaining = Date.parse(at) - nowMs;
  return remaining > 0 && remaining <= horizonMs;
}

export function readSimpleConductorTasks(): TaskStoreReadResult {
  const result = withTaskLock(readTasksUnlocked);
  return result ?? { ok: false, reason: 'task store lock is unavailable' };
}

export function claimSimpleConductorTask(
  taskId: string,
  expectedGenerationId: string,
  nowMs = Date.now(),
): TaskClaimResult {
  const result = withTaskLock<TaskClaimResult>(() => {
    const read = readTasksUnlocked();
    if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.reason };
    const index = read.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, reason: 'changed', detail: 'task row disappeared' };
    const current = read.tasks[index];
    if (current.done) return { ok: false, reason: 'done', detail: 'task is already complete' };
    if (simpleConductorTaskGenerationId(current) !== expectedGenerationId) {
      return { ok: false, reason: 'changed', detail: 'task generation changed before dispatch' };
    }
    if (current.retryAfter && pendingUntil(current.retryAfter, nowMs, MAX_RETRY_HORIZON_MS)) {
      return { ok: false, reason: 'cooling', detail: 'task retry window has not opened' };
    }
    if (current.dispatchLease && current.dispatchLease.generationId === expectedGenerationId) {
      return pendingUntil(current.dispatchLease.expiresAt, nowMs, MAX_LEASE_HORIZON_MS)
        ? { ok: false, reason: 'busy', detail: 'task has an active dispatch lease' }
        : {
            ok: false,
            reason: 'reconciliation-required',
            detail: 'task dispatch lease expired without terminal authority',
          };
    }
    const token = randomUUID();
    const now = new Date(nowMs).toISOString();
    const lease: SimpleConductorDispatchLease = {
      token,
      generationId: expectedGenerationId,
      claimedAt: now,
      expiresAt: new Date(nowMs + LEASE_DURATION_MS).toISOString(),
      ownerPid: process.pid,
    };
    const revision = (current.revision ?? 0) + 1;
    const claimed: TaskSpec = {
      ...current,
      attempts: (current.attempts ?? 0) + 1,
      dispatchedAt: now,
      revision,
      dispatchLease: lease,
    };
    const next = [...read.tasks];
    next[index] = claimed;
    try {
      writeTasksUnlocked(next);
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : 'task claim persistence failed',
      };
    }
    return {
      ok: true,
      claim: {
        task: claimed,
        token,
        generationId: expectedGenerationId,
        revision,
        rowDigest: createHash('sha256').update(stableJson(claimed)).digest('hex'),
      },
    };
  });
  return result ?? { ok: false, reason: 'unavailable', detail: 'task store lock is unavailable' };
}

export function settleSimpleConductorTask(
  claim: ClaimedSimpleConductorTask,
  settlement: TaskSettlement,
): TaskSettlementResult {
  const result = withTaskLock<TaskSettlementResult>(() => {
    const read = readTasksUnlocked();
    if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.reason };
    const index = read.tasks.findIndex((task) => task.id === claim.task.id);
    if (index < 0) return { ok: false, reason: 'changed', detail: 'task row disappeared' };
    const current = read.tasks[index];
    const lease = current.dispatchLease;
    if (simpleConductorTaskGenerationId(current) !== claim.generationId ||
      current.revision !== claim.revision ||
      createHash('sha256').update(stableJson(current)).digest('hex') !== claim.rowDigest ||
      !lease || lease.token !== claim.token || lease.generationId !== claim.generationId) {
      return { ok: false, reason: 'changed', detail: 'task generation or dispatch lease changed' };
    }
    const nextTask: TaskSpec = { ...current, ...settlement, revision: claim.revision + 1 };
    delete nextTask.dispatchLease;
    if (settlement.proposalId === undefined) delete nextTask.proposalId;
    if (settlement.candidateProposalId === undefined) delete nextTask.candidateProposalId;
    if (settlement.retryAfter === undefined) delete nextTask.retryAfter;
    const next = [...read.tasks];
    next[index] = nextTask;
    try {
      writeTasksUnlocked(next);
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : 'task settlement persistence failed',
      };
    }
    return { ok: true, task: nextTask };
  });
  return result ?? { ok: false, reason: 'unavailable', detail: 'task store lock is unavailable' };
}

export function reconcileSimpleConductorTask(
  taskId: string,
  expectedGenerationId: string,
  settlement: TaskSettlement,
  nowMs = Date.now(),
): TaskSettlementResult {
  const result = withTaskLock<TaskSettlementResult>(() => {
    const read = readTasksUnlocked();
    if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.reason };
    const index = read.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, reason: 'changed', detail: 'task row disappeared' };
    const current = read.tasks[index];
    if (simpleConductorTaskGenerationId(current) !== expectedGenerationId) {
      return { ok: false, reason: 'changed', detail: 'task generation changed during reconciliation' };
    }
    if (current.dispatchLease && current.dispatchLease.generationId === expectedGenerationId &&
      pendingUntil(current.dispatchLease.expiresAt, nowMs, MAX_LEASE_HORIZON_MS)) {
      return { ok: false, reason: 'changed', detail: 'task has an active dispatch lease' };
    }
    const nextTask: TaskSpec = {
      ...current,
      ...settlement,
      revision: (current.revision ?? 0) + 1,
    };
    delete nextTask.dispatchLease;
    if (settlement.proposalId === undefined) delete nextTask.proposalId;
    if (settlement.candidateProposalId === undefined) delete nextTask.candidateProposalId;
    if (settlement.retryAfter === undefined) delete nextTask.retryAfter;
    const next = [...read.tasks];
    next[index] = nextTask;
    try {
      writeTasksUnlocked(next);
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : 'task reconciliation persistence failed',
      };
    }
    return { ok: true, task: nextTask };
  });
  return result ?? { ok: false, reason: 'unavailable', detail: 'task store lock is unavailable' };
}

// ---------------------------------------------------------------------------
// Operator recovery of reconciliation-required leases
// ---------------------------------------------------------------------------

export type LeaseState = 'active' | 'expired' | 'skewed';

export interface ReconciliationRequiredTask {
  task: TaskSpec;
  generationId: string;
  lease: SimpleConductorDispatchLease;
  /** expired: past expiresAt; skewed: expiresAt beyond any horizon this store writes. */
  leaseState: Exclude<LeaseState, 'active'>;
}

export type LeaseOwnerProof = 'owner-dead' | 'owner-pid-reused' | 'claimed-before-boot';

/** Injectable process probes; defaults read the real host. */
export interface LeaseOwnerProbe {
  selfPid?: number;
  /** 'dead' only on ESRCH; EPERM and any other error count as 'exists'. */
  signal?: (pid: number) => 'exists' | 'dead';
  startedAtMs?: (pid: number, nowMs: number) => number | null;
  bootTimeMs?: (nowMs: number) => number | null;
}

export type ClearReconciliationResult =
  | {
      ok: true;
      changed: boolean;
      task: TaskSpec;
      proof: LeaseOwnerProof;
      leaseState: Exclude<LeaseState, 'active'>;
    }
  | {
      ok: false;
      reason: 'not-found' | 'not-reconciliation-required' | 'owner-not-disproved' | 'changed' | 'unavailable';
      detail: string;
    };

function leaseState(lease: SimpleConductorDispatchLease, nowMs: number): LeaseState {
  if (pendingUntil(lease.expiresAt, nowMs, MAX_LEASE_HORIZON_MS)) return 'active';
  return Date.parse(lease.expiresAt) - nowMs > 0 ? 'skewed' : 'expired';
}

/** The task as the conductor sees it when claim answers `reconciliation-required`, or null. */
function reconciliationRequired(task: TaskSpec, nowMs: number): ReconciliationRequiredTask | null {
  const lease = task.dispatchLease;
  if (task.done || !lease) return null;
  let generationId: string;
  try {
    generationId = simpleConductorTaskGenerationId(task);
  } catch {
    return null;
  }
  if (lease.generationId !== generationId) return null;
  const state = leaseState(lease, nowMs);
  return state === 'active' ? null : { task, generationId, lease, leaseState: state };
}

export function listReconciliationRequiredSimpleConductorTasks(
  nowMs = Date.now(),
): { ok: true; tasks: ReconciliationRequiredTask[] } | { ok: false; reason: string } {
  const read = readSimpleConductorTasks();
  if (!read.ok) return read;
  return {
    ok: true,
    tasks: read.tasks.flatMap((task) => {
      const found = reconciliationRequired(task, nowMs);
      return found ? [found] : [];
    }),
  };
}

function defaultSignal(pid: number): 'exists' | 'dead' {
  try {
    process.kill(pid, 0);
    return 'exists';
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH' ? 'dead' : 'exists';
  }
}

function defaultBootTimeMs(nowMs: number): number | null {
  try {
    const seconds = osUptime();
    return Number.isFinite(seconds) && seconds > 0 ? nowMs - seconds * 1_000 : null;
  } catch {
    return null;
  }
}

/**
 * Prove the process that claimed `lease` is not running, or explain why not.
 *  - owner-dead: the recorded owner pid answers ESRCH.
 *  - owner-pid-reused: the lease outlived its full duration and the process
 *    now holding the owner pid started after the claim (the shared daemon
 *    pid-reuse proof), so it cannot be the claimant.
 *  - claimed-before-boot: the claim predates the host's current boot.
 * Anything else (live owner pid, unprovable start time, a legacy lease without
 * an owner pid and no reboot since the claim) is not a proof.
 */
export function proveLeaseOwnerNotRunning(
  lease: SimpleConductorDispatchLease,
  nowMs = Date.now(),
  probe: LeaseOwnerProbe = {},
): { ok: true; proof: LeaseOwnerProof } | { ok: false; detail: string } {
  const claimedMs = Date.parse(lease.claimedAt);
  if (!Number.isFinite(claimedMs)) return { ok: false, detail: 'lease claim time is unparsable' };
  const ownerPid = lease.ownerPid;
  if (ownerPid !== undefined) {
    if (ownerPid === (probe.selfPid ?? process.pid)) {
      return { ok: false, detail: `lease owner pid ${ownerPid} is this process` };
    }
    if ((probe.signal ?? defaultSignal)(ownerPid) === 'dead') return { ok: true, proof: 'owner-dead' };
    if (pidProvablyReusedSince({
      pid: ownerPid,
      acquiredAtMs: claimedMs,
      heartbeatAtMs: claimedMs,
      staleMs: LEASE_DURATION_MS,
      nowMs,
      startedAtMs: probe.startedAtMs ?? processStartedAtMs,
    })) return { ok: true, proof: 'owner-pid-reused' };
  }
  const bootMs = (probe.bootTimeMs ?? defaultBootTimeMs)(nowMs);
  if (bootMs !== null && Number.isFinite(bootMs) && claimedMs < bootMs - PID_REUSE_SLACK_MS) {
    return { ok: true, proof: 'claimed-before-boot' };
  }
  return {
    ok: false,
    detail: ownerPid === undefined
      ? 'lease predates owner-pid recording and the host has not rebooted since the claim; the owner cannot be proven gone'
      : `lease owner pid ${ownerPid} is still running or its identity cannot be disproved`,
  };
}

/**
 * Clear one reconciliation-required lease back to a claimable row, only when
 * its owner is provably not running. The lease is removed and the revision
 * bumps; attempts and any candidate/proposal ids are kept, so the conductor
 * still reconciles known proposals before it ever redispatches. `dryRun`
 * proves and reports without writing. The process probes run outside the
 * task lock; the write re-checks under the lock that the row is unchanged.
 */
export function clearReconciliationRequiredSimpleConductorTask(
  taskId: string,
  opts: { dryRun?: boolean; nowMs?: number; probe?: LeaseOwnerProbe } = {},
): ClearReconciliationResult {
  const nowMs = opts.nowMs ?? Date.now();
  const read = readSimpleConductorTasks();
  if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.reason };
  const current = read.tasks.find((task) => task.id === taskId);
  if (!current) return { ok: false, reason: 'not-found', detail: `no task with id ${taskId}` };
  const found = reconciliationRequired(current, nowMs);
  if (!found) {
    return {
      ok: false,
      reason: 'not-reconciliation-required',
      detail: current.done
        ? 'task is already complete'
        : current.dispatchLease
          ? 'task lease is active or belongs to a superseded generation'
          : 'task has no dispatch lease',
    };
  }
  const owner = proveLeaseOwnerNotRunning(found.lease, nowMs, opts.probe);
  if (!owner.ok) return { ok: false, reason: 'owner-not-disproved', detail: owner.detail };
  const cleared: TaskSpec = {
    ...current,
    revision: (current.revision ?? 0) + 1,
    lastError: `dispatch lease cleared by operator (${owner.proof}); task is claimable again`,
  };
  delete cleared.dispatchLease;
  if (opts.dryRun) {
    return { ok: true, changed: false, task: cleared, proof: owner.proof, leaseState: found.leaseState };
  }
  const result = withTaskLock<ClearReconciliationResult>(() => {
    const locked = readTasksUnlocked();
    if (!locked.ok) return { ok: false, reason: 'unavailable', detail: locked.reason };
    const index = locked.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, reason: 'changed', detail: 'task row disappeared' };
    if (stableJson(locked.tasks[index]) !== stableJson(current)) {
      return { ok: false, reason: 'changed', detail: 'task row changed while the owner was being proven' };
    }
    const next = [...locked.tasks];
    next[index] = cleared;
    try {
      writeTasksUnlocked(next);
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : 'task lease clear persistence failed',
      };
    }
    return { ok: true, changed: true, task: cleared, proof: owner.proof, leaseState: found.leaseState };
  });
  return result ?? { ok: false, reason: 'unavailable', detail: 'task store lock is unavailable' };
}
