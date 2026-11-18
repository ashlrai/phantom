/** Sequential worker contexts over the existing authoritative node queue; no I/O or provider policy. */
import type { JobClaim, Pulled } from '../drive/nodes/index.js';
import { validId } from '../drive/nodes/state.js';

export interface SessionPoolPolicy {
  tasks?: number;
  rotateAfterTasks?: number;
  rotateAfterMs?: number;
  taskTimeoutMs?: number;
  renewEveryMs?: number;
}
export interface SessionExecutor {
  run(task: Pulled, signal: AbortSignal): Promise<string>;
  /** Synchronously fence/terminate this context, including any outstanding run. */
  close(): void;
}
export interface SessionPoolPorts {
  /** Unique attempt namespace, never a credential. */
  id: string;
  now(): number;
  held(): boolean;
  heartbeat(): void;
  pull(): Pulled | null;
  renew(claim: JobClaim): JobClaim | null;
  complete(claim: JobClaim, resultRef: string): boolean;
  leave(): void;
  open(): SessionExecutor;
  emit(event: SessionPoolEvent): void;
}
export interface SessionPoolEvent {
  schema: 'fleet.session-pool.v1';
  ts: string;
  sessionId: string;
  event: 'session_start' | 'session_rotate' | 'launch' | 'finish' | 'session_stop';
  context: number;
  /** Attempt ID is unique across retries; jobId is the logical queue ID. */
  job?: string;
  jobId?: string;
  outcome?: 'completed' | 'lease-expiry';
}
export interface SessionPoolResult {
  completed: number;
  contexts: number;
  reason: 'limit' | 'empty' | 'aborted' | 'held' | 'failed';
}

export function sessionPoolPolicy(policy: SessionPoolPolicy = {}): Required<SessionPoolPolicy> {
  const p = { tasks: 100, rotateAfterTasks: 25, rotateAfterMs: 30 * 60_000,
    taskTimeoutMs: 30 * 60_000, renewEveryMs: 3000, ...policy };
  for (const [key, max] of Object.entries({ tasks: 100, rotateAfterTasks: 100,
    rotateAfterMs: 30 * 60_000, taskTimeoutMs: 30 * 60_000, renewEveryMs: 3000 })) {
    const value = p[key as keyof typeof p];
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid session pool policy');
  }
  return p;
}

/** Owns an already joined, single-slot node. Never prefetches. On death, unfinished
 * work becomes routable at claim expiry (30s by default), even without cleanup.
 * Queue adapters must perform all fencing comparisons at the authority.
 */
export async function runSessionPool(ports: SessionPoolPorts, policy: SessionPoolPolicy = {}, signal?: AbortSignal): Promise<SessionPoolResult> {
  const p = sessionPoolPolicy(policy);
  if (!validId(ports.id)) throw new Error('Invalid session pool identity');
  const result: SessionPoolResult = { completed: 0, contexts: 0, reason: 'limit' };
  let executor: SessionExecutor | undefined;
  let contextTasks = 0, contextAt = 0;
  let active: Pulled | null = null;
  const emit = (event: SessionPoolEvent['event'], outcome?: SessionPoolEvent['outcome']) => ports.emit({
    schema: 'fleet.session-pool.v1', ts: new Date(ports.now()).toISOString(), sessionId: ports.id,
    event, context: result.contexts, ...(active ? { job: `${ports.id}:${result.completed + 1}`, jobId: active.job.id } : {}),
    ...(outcome ? { outcome } : {}),
  });
  const check = () => {
    if (signal?.aborted || ports.held()) throw new Error('Session stopped');
    ports.heartbeat();
  };
  const renew = () => {
    check();
    const next = ports.renew(active!.claim);
    if (!next || next.token !== active!.claim.token || next.leaderToken !== active!.claim.leaderToken ||
        next.session !== active!.claim.session || next.nodeId !== active!.claim.nodeId || next.jobId !== active!.job.id) {
      throw new Error('Session lease lost');
    }
    active = { ...active!, claim: next };
  };
  try {
    emit('session_start');
    while (result.completed < p.tasks) {
      if (signal?.aborted) { result.reason = 'aborted'; break; }
      if (ports.held()) { result.reason = 'held'; break; }
      check();
      active = ports.pull();
      if (!active) { result.reason = 'empty'; break; }
      renew();
      if (executor && (contextTasks >= p.rotateAfterTasks || ports.now() - contextAt >= p.rotateAfterMs)) {
        executor.close(); executor = undefined;
        emit('session_rotate');
      }
      if (!executor) { executor = ports.open(); result.contexts++; contextTasks = 0; contextAt = ports.now(); }
      emit('launch');
      const controller = new AbortController();
      let rejectStop!: (error: Error) => void;
      const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
      const stop = () => { controller.abort(); rejectStop(new Error('Session interrupted')); };
      const timer = setInterval(() => { try { renew(); } catch { stop(); } }, p.renewEveryMs);
      const deadline = setTimeout(stop, p.taskTimeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      try {
        if (signal?.aborted) stop();
        const ref = await Promise.race([stopped, Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error('Session interrupted');
          return executor!.run(structuredClone(active!), controller.signal);
        })]);
        // An expired or superseded claim can never publish a late result.
        renew();
        if (controller.signal.aborted || !validId(ref) || !ports.complete(active!.claim, ref)) throw new Error('Session completion refused');
      } finally {
        clearInterval(timer); clearTimeout(deadline);
        signal?.removeEventListener('abort', stop);
      }
      // Clear ownership before logging: an ambiguous metric write must not requeue a completed task.
      try { emit('finish', 'completed'); } finally { active = null; result.completed++; contextTasks++; }
    }
  } catch {
    result.reason = signal?.aborted ? 'aborted' : 'failed';
  } finally {
    try { executor?.close(); } catch { result.reason = 'failed'; }
    // leave fences this session; expiry requeues any outstanding claim without minting authority locally.
    try { ports.leave(); } catch { result.reason = 'failed'; }
    try { if (active) emit('finish', 'lease-expiry'); active = null; emit('session_stop'); }
    catch { result.reason = 'failed'; }
  }
  return result;
}
