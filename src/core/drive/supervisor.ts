/** Scheduling policy is independent of DRIVER-1 storage and the host semaphore. */
export type DriveJobState = 'READY' | 'HELD' | 'STARTING' | 'RUNNING' | 'FINISHED' | 'FAILED' | 'PUBLISHING' | 'PUBLISHED' | 'PUBLISH_UNKNOWN';
export interface DriveJob {
  id: string;
  pool: string;
  state: DriveJobState;
  priority: number;
  exitCode?: number;
}
export interface DriveSnapshot {
  version: 1;
  pools: { id: string; floor: number; ceiling: number }[];
  maxRunning: number;
  paused: boolean;
  admission: 'open' | 'closed' | 'unknown';
  jobs: DriveJob[];
}
export interface DriveReport {
  version: 1;
  at: string;
  dryRun: boolean;
  paused: boolean;
  active: number;
  ready: number;
  planned: string[];
  launched: string[];
  published: string[];
  publicationUnknown: string[];
  held: string | null;
}

/**
 * The host bridge owns native queue transitions and dispatchd-format serialization.
 * Every mutation must verify the shared ownership lease. launch must atomically
 * recheck PAUSE, capacity and #1014 admission, persist STARTING, then call the
 * existing sandboxed pool runner. A lost reply must never make a job READY again.
 */
export interface DriveBridge {
  snapshot(lease?: string): Promise<DriveSnapshot>;
  acquire(): Promise<string | null>;
  reap(lease: string): Promise<void>;
  launch(lease: string, job: string): Promise<'launched' | 'held'>;
  reservePublish(lease: string, job: string): Promise<boolean>;
  finishPublish(lease: string, job: string, outcome: 'published' | 'unknown'): Promise<void>;
  writeStatus(lease: string, report: DriveReport): Promise<void>;
  release(lease: string): Promise<void>;
}
export interface DriveDependencies {
  bridge: DriveBridge;
  /** True for PAUSE, KILL or an unreadable control file. Checked before every launch. */
  paused(): Promise<boolean>;
  /** Only the existing publish.sh may implement this callback in the CLI. */
  publish(job: string, lease: string): Promise<void>;
  now?(): Date;
}

const states = new Set<DriveJobState>(['READY', 'HELD', 'STARTING', 'RUNNING', 'FINISHED', 'FAILED', 'PUBLISHING', 'PUBLISHED', 'PUBLISH_UNKNOWN']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}
function id(value: unknown): value is string { return typeof value === 'string' && identifier.test(value); }

/** Never interpret a corrupt or incomplete snapshot as an empty fleet. */
export function parseDriveSnapshot(value: unknown): DriveSnapshot {
  const invalid = (): never => { throw new Error('Invalid drive bridge snapshot'); };
  if (!object(value) || value.version !== 1 || !count(value.maxRunning) ||
      typeof value.paused !== 'boolean' || typeof value.admission !== 'string' || !['open', 'closed', 'unknown'].includes(value.admission) ||
      !Array.isArray(value.pools) || !Array.isArray(value.jobs) || value.jobs.length > 100_000) return invalid();
  const pools = new Map<string, { id: string; floor: number; ceiling: number }>();
  for (const pool of value.pools) {
    if (!object(pool) || !id(pool.id) || pools.has(pool.id) || !count(pool.floor) ||
        !count(pool.ceiling) || pool.floor > pool.ceiling) return invalid();
    pools.set(pool.id, { id: pool.id, floor: pool.floor, ceiling: pool.ceiling });
  }
  if ([...pools.values()].reduce((total, pool) => total + pool.floor, 0) > value.maxRunning) return invalid();
  const jobs: DriveJob[] = [];
  const ids = new Set<string>();
  for (const job of value.jobs) {
    if (!object(job) || !id(job.id) || ids.has(job.id) || typeof job.pool !== 'string' || !pools.has(job.pool) ||
        !states.has(job.state as DriveJobState) || !Number.isSafeInteger(job.priority) ||
        (job.exitCode !== undefined && !Number.isSafeInteger(job.exitCode)) ||
        (job.state === 'FINISHED' && job.exitCode === undefined)) return invalid();
    ids.add(job.id);
    jobs.push({ id: job.id, pool: job.pool, state: job.state as DriveJobState,
      priority: job.priority as number, ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode as number }) });
  }
  return { version: 1, pools: [...pools.values()], maxRunning: value.maxRunning,
    paused: value.paused, admission: value.admission as DriveSnapshot['admission'], jobs };
}

const active = (job: DriveJob): boolean => job.state === 'RUNNING' || job.state === 'STARTING';

/** Floor deficits get first choice; priority and queue order break ties. */
export function planDrive(snapshot: DriveSnapshot): string[] {
  snapshot = parseDriveSnapshot(snapshot);
  if (snapshot.paused || snapshot.admission !== 'open') return [];
  const counts = new Map(snapshot.pools.map(pool => [pool.id, snapshot.jobs.filter(job => job.pool === pool.id && active(job)).length]));
  const pools = new Map(snapshot.pools.map(pool => [pool.id, pool]));
  let total = snapshot.jobs.filter(active).length;
  const ready = snapshot.jobs.filter(job => job.state === 'READY');
  const result: string[] = [];
  while (total < snapshot.maxRunning) {
    const eligible = ready.filter(job => counts.get(job.pool)! < pools.get(job.pool)!.ceiling);
    eligible.sort((a, b) => {
      const deficit = (job: DriveJob): number => Number(counts.get(job.pool)! < pools.get(job.pool)!.floor);
      return deficit(b) - deficit(a) || b.priority - a.priority;
    });
    const job = eligible[0];
    if (!job) break;
    result.push(job.id);
    ready.splice(ready.indexOf(job), 1);
    counts.set(job.pool, counts.get(job.pool)! + 1);
    total++;
  }
  return result;
}

export async function driveTick(deps: DriveDependencies, options: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<DriveReport> {
  const { bridge } = deps;
  const dryRun = options.dryRun === true;
  let lease: string | null = null;
  const report: DriveReport = { version: 1, at: (deps.now?.() ?? new Date()).toISOString(), dryRun,
    paused: false, active: 0, ready: 0, planned: [], launched: [], published: [], publicationUnknown: [], held: null };
  const snapshot = async (): Promise<DriveSnapshot> => {
    const state = parseDriveSnapshot(await bridge.snapshot(lease ?? undefined));
    state.paused ||= await deps.paused();
    report.paused = state.paused;
    report.active = state.jobs.filter(active).length;
    report.ready = state.jobs.filter(job => job.state === 'READY').length;
    report.held = state.paused ? 'paused' : state.admission !== 'open' ? `admission-${state.admission}` : null;
    return state;
  };
  try {
    if (options.signal?.aborted) { report.held = 'stopping'; return report; }
    if (dryRun) {
      report.planned = planDrive(await snapshot());
      return report;
    }
    lease = await bridge.acquire();
    if (!lease) { report.held = 'ownership-busy'; return report; }
    if (options.signal?.aborted) { report.held = 'stopping'; return report; }
    // Reaping still proceeds under memory pressure; it never starts a worker.
    await bridge.reap(lease);
    let state = await snapshot();
    for (const job of state.jobs) {
      if (options.signal?.aborted) break;
      if (job.state !== 'FINISHED' || job.exitCode !== 0 || !await bridge.reservePublish(lease, job.id)) continue;
      // Persist PUBLISHING before calling the only pusher. A lost acknowledgement
      // is ambiguous, never an automatic retry of an outward mutation.
      let outcome: 'published' | 'unknown' = options.signal?.aborted ? 'unknown' : 'published';
      if (outcome === 'published') {
        try { await deps.publish(job.id, lease); } catch { outcome = 'unknown'; }
      }
      await bridge.finishPublish(lease, job.id, outcome);
      if (outcome === 'published') report.published.push(job.id);
      else report.publicationUnknown.push(job.id);
    }
    state = await snapshot();
    report.planned = planDrive(state);
    const launchBudget = report.planned.length;
    const attempted = new Set<string>();
    while (attempted.size < launchBudget && !options.signal?.aborted) {
      // Fresh snapshots account for external pool users and changed ceilings.
      state = await snapshot();
      const next = planDrive(state).find(job => !attempted.has(job));
      if (!next) break;
      attempted.add(next);
      if (await deps.paused()) { report.paused = true; report.held = 'paused'; break; }
      if (options.signal?.aborted) break;
      if (await bridge.launch(lease, next) === 'held') {
        report.held = 'launch-held';
        break;
      }
      report.launched.push(next);
      const after = await snapshot();
      if (!after.jobs.some(job => job.id === next && job.state !== 'READY')) {
        throw new Error('Drive bridge did not persist the launch');
      }
    }
    if (options.signal?.aborted) report.held = 'stopping';
    await bridge.writeStatus(lease, report);
    return report;
  } finally {
    if (lease) await bridge.release(lease);
  }
}

export async function driveLoop(deps: DriveDependencies, options: {
  once?: boolean; dryRun?: boolean; tickMs?: number; signal?: AbortSignal;
  report?(report: DriveReport): void; error?(): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
} = {}): Promise<void> {
  const tickMs = options.tickMs ?? 30_000;
  if (!Number.isSafeInteger(tickMs) || tickMs < 1_000 || tickMs > 86_400_000) throw new Error('Drive tick must be between 1 and 86400 seconds');
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) done(); else signal?.addEventListener('abort', done, { once: true });
  }));
  do {
    if (options.signal?.aborted) break;
    try {
      const report = await driveTick(deps, options);
      options.report?.(report);
    }
    catch (error) {
      if (options.once || options.dryRun) throw error;
      options.error?.();
    }
    if (options.once || options.dryRun || options.signal?.aborted) break;
    await sleep(tickMs, options.signal);
  } while (!options.signal?.aborted);
}
