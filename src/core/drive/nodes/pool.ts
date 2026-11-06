/** A designated backup is the single durable witness. No election from copied state. */
import { scrubSecrets } from '../../util/scrub.js';
import { DriveNodes, type NodesStore } from './index.js';
import { validId, type NodesState } from './state.js';
import { executeNodeFleet } from './commands.js';

export const PRIMARY_TIMEOUT_MS = 15 * 60_000;
export type PoolRole = 'primary' | 'backup';
export interface PoolRequest {
  origin: PoolRole;
  action: 'heartbeat' | 'execute';
  verb?: string;
  args?: string[];
}
export interface PoolReply {
  schemaVersion: 1;
  active: PoolRole;
  epoch: number;
  demoted: boolean;
  result: Record<string, unknown>;
}

export function initializePool(store: NodesStore, primary: string, backup: string, now = Date.now()): void {
  if (!validId(primary) || !validId(backup) || primary === backup || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('Invalid drive pool identity');
  }
  store.transaction(state => {
    if (state.pool || state.nodes.length || state.jobs.length || state.sequence) throw new Error('Pool requires a fresh witness store');
    state.pool = { primary, backup, active: 'primary', epoch: ++state.sequence, heartbeatAt: now };
    state.observedAt = now;
  });
}

/** Runs role transition, claim mutation and completion in the SAME disk transaction.
 * The witness clock is the only clock. A primary never self-admits while disconnected.
 * Once promoted, backup custody is sticky; primary heartbeat cannot seize it back.
 */
export function executePool(store: NodesStore, request: PoolRequest, owner: string, now = Date.now()): PoolReply {
  if (!request || !['primary', 'backup'].includes(request.origin) || !['heartbeat', 'execute'].includes(request.action) ||
      !validId(owner) || (request.args !== undefined && (!Array.isArray(request.args) || request.args.length > 40 ||
        !request.args.every(a => typeof a === 'string' && a.length <= 4096 && scrubSecrets(a) === a)))) throw new Error('Invalid drive pool request');
  return store.transaction(state => {
    const pool = state.pool;
    if (!pool || !Number.isSafeInteger(now) || now < state.observedAt) throw new Error('Invalid drive pool authority clock');
    state.observedAt = now;
    if (pool.active === 'primary' && now - pool.heartbeatAt >= PRIMARY_TIMEOUT_MS) {
      if (state.sequence === Number.MAX_SAFE_INTEGER) throw new Error('Drive fencing counter exhausted');
      pool.active = 'backup';
      pool.epoch = ++state.sequence;
      // Fence all old claims even if a worker's job lease has not expired.
      state.leader = null;
    }
    const demoted = request.origin !== pool.active;
    if (request.action === 'heartbeat') {
      if (!demoted && request.origin === 'primary') pool.heartbeatAt = now;
      return { schemaVersion: 1, active: pool.active, epoch: pool.epoch, demoted, result: { heartbeatAt: pool.heartbeatAt } };
    }
    const verb = request.verb;
    if (!verb || !['join', 'beat', 'enqueue', 'plan', 'pull', 'renew', 'complete', 'list', 'status', 'leave'].includes(verb)) {
      throw new Error('Invalid drive pool verb');
    }
    const read = ['list', 'status', 'plan'].includes(verb);
    if (demoted && !read) return { schemaVersion: 1, active: pool.active, epoch: pool.epoch, demoted, result: { held: 'inactive-runner' } };
    const args = request.args ?? [];
    // One explicitly configured team scope, never caller-selected visibility.
    const suppliedOwner = args.findIndex(a => a === '--owner' || a.startsWith('--owner='));
    if (suppliedOwner >= 0) {
      const flag = args[suppliedOwner]!;
      const value = flag.includes('=') ? flag.slice(8) : args[suppliedOwner + 1];
      if (value !== owner) throw new Error('Invalid drive pool owner');
    }
    const scoped = ['join', 'enqueue', 'status', 'list'].includes(verb) && suppliedOwner < 0 ? [...args, '--owner', owner] : args;
    const nodes = new DriveNodes({ transaction: fn => fn(state) }, { now: () => now });
    return { schemaVersion: 1, active: pool.active, epoch: pool.epoch, demoted,
      result: executeNodeFleet(verb, scoped, nodes) };
  });
}

/** A snapshot is evidence only. It is never accepted as a new witness authority. */
export function poolSnapshot(store: NodesStore): NodesState {
  return store.transaction(state => state);
}
