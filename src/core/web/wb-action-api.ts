/** Desktop actions: existing mutation authority, durable replay fence, value-free audit. */
import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { passesMutationGate, readBody } from './api.js';
import { sendJson } from './read-session.js';
import { scrubSecrets } from '../util/scrub.js';
import { readLaneTargets, setLaneTarget } from '../fleet/runs-lane-targets.js';
import { QueueStore } from '../queue/store.js';
import { reclaimableTempWorktrees } from '../inbox/temp-worktree-reaper.js';
import {
  queueJobProblem, runSteerAction, steerNoteProblem, steerPriorityProblem, stopJobProblem,
  type SteerDeps, type SteerRequest,
} from '../workbench/steer.js';

export const WB_ACTION_PATH = '/api/wb/v1/action';
const actions = ['lane.pause', 'lane.resume', 'lane.target', 'queue.hold', 'queue.unhold', 'reap.count', 'job.retry',
  'steer.note', 'queue.reprioritize', 'job.stop'] as const;
type Action = typeof actions[number];
interface Request { action: Action; nonce: string; dryRun: boolean; lane?: string; job?: string; target?: number; text?: string; priority?: string }
function parse(value: unknown): Request | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  if (!actions.includes(b.action as Action) || typeof b.nonce !== 'string' || !/^[a-f0-9]{32,64}$/.test(b.nonce) ||
      (b.dryRun !== undefined && typeof b.dryRun !== 'boolean')) return null;
  const action = b.action as Action;
  const fields = ['action', 'nonce', 'dryRun'];
  if (action.startsWith('lane.')) {
    fields.push('lane');
    if (typeof b.lane !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(b.lane) || scrubSecrets(b.lane) !== b.lane) return null;
    if (action === 'lane.target') {
      fields.push('target');
      if (!Number.isSafeInteger(b.target) || Number(b.target) < 0 || Number(b.target) > 1000) return null;
    }
  } else if (action === 'steer.note') {
    fields.push('text');
    if (steerNoteProblem(b.text) !== null) return null;
  } else if (action === 'queue.reprioritize') {
    fields.push('job', 'priority');
    if (queueJobProblem(b.job) || steerPriorityProblem(b.priority)) return null;
  } else if (action === 'job.stop') {
    fields.push('job');
    if (stopJobProblem(b.job)) return null;
  } else if (action !== 'reap.count') {
    fields.push('job');
    if (typeof b.job !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(b.job) || scrubSecrets(b.job) !== b.job) return null;
  }
  if (Object.keys(b).some(key => !fields.includes(key))) return null;
  return { ...b, action, dryRun: b.dryRun !== false } as Request;
}
const owned = (uid: number) => !process.getuid || uid === process.getuid();
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (!s.isDirectory() || !owned(s.uid) || (s.mode & 0o077)) throw new Error('Unsafe directory');
}
/** Store the already-issued server capability; never mint another token. */
export async function storeWbToken(directory: string, token: string): Promise<void> {
  await privateDirectory(directory);
  const file = await open(join(directory, 'token'), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const s = await file.stat();
    if (!s.isFile() || !owned(s.uid) || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) throw new Error('Unsafe token file');
    await file.truncate(0);
    await file.writeFile(token);
    await file.sync();
  } finally { await file.close(); }
}
async function audit(directory: string, action: Action | 'invalid', outcome: string): Promise<void> {
  const file = await open(join(directory, 'audit.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const s = await file.stat();
    if (!s.isFile() || !owned(s.uid) || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) throw new Error('Unsafe audit');
    await file.writeFile(JSON.stringify({ v: 1, at: new Date().toISOString(), action, outcome }) + '\n');
    await file.sync();
  } finally { await file.close(); }
}
interface Executed { count?: number; outcome?: string }
async function execute(b: Request, runsDir: string, deps?: SteerDeps): Promise<Executed> {
  if (b.action === 'steer.note' || b.action === 'queue.reprioritize' || b.action === 'job.stop') {
    const request: SteerRequest = b.action === 'steer.note'
      ? { action: b.action, text: b.text! }
      : b.action === 'queue.reprioritize'
        ? { action: b.action, job: b.job!, priority: b.priority! }
        : { action: b.action, job: b.job! };
    const result = await runSteerAction(request, { dryRun: b.dryRun, runsDir, deps });
    switch (result.action) {
      case 'steer.note': return { outcome: result.outcome, count: result.bytes };
      case 'queue.reprioritize': return { outcome: `${result.from}>${result.to}` };
      case 'job.stop': return { outcome: result.outcome, count: result.pids.length };
    }
  }
  if (b.action.startsWith('lane.')) {
    const state = await readLaneTargets({ runsDir });
    const lane = state.lanes.find(row => row.lane === b.lane);
    if (state.sourceState !== 'healthy' || !lane) throw new Error('Unavailable lane');
    const target = b.action === 'lane.pause' ? 0 : b.action === 'lane.resume' ? lane.pausedFrom : b.target;
    if (target == null || target < lane.floor || target > lane.ceiling) throw new Error('Invalid target');
    await setLaneTarget(b.lane!, target, { runsDir, dryRun: b.dryRun });
  } else if (b.action === 'reap.count') {
    const result = reclaimableTempWorktrees(process.cwd());
    if (!result.complete) throw new Error('Incomplete count');
    return { count: result.paths.length };
  } else {
    const store = new QueueStore(join(runsDir, 'queue'));
    if (b.action === 'job.retry') {
      const planned = await store.replay({ ids: [b.job!], dryRun: true });
      if (!planned.length) throw new Error('Not retryable');
      if (!b.dryRun) await store.replay({ ids: [b.job!] });
    } else await store.hold(b.job!, b.action === 'queue.hold', b.dryRun);
  }
  return {};
}
export async function handleWbAction(req: IncomingMessage, res: ServerResponse,
  ctx: { token: string; allowDispatch: boolean },
  options: { directory?: string; runsDir?: string; steerDeps?: SteerDeps } = {}): Promise<boolean> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' }); return true; }
  if (!ctx.allowDispatch) { sendJson(res, 403, { error: 'actions disabled' }); return true; }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  const directory = options.directory ?? join(homedir(), '.ashlr', 'wb');
  let body: Request | null = null;
  try {
    await privateDirectory(directory);
    try { body = parse(JSON.parse(await readBody(req, 8192))); } catch { /* fixed refusal below */ }
    if (!body) { await audit(directory, 'invalid', 'refused'); sendJson(res, 400, { error: 'invalid action' }); return true; }
    await privateDirectory(join(directory, 'nonces'));
    const digest = createHash('sha256').update(body.nonce).digest('hex');
    try {
      const claim = await open(join(directory, 'nonces', digest), 'wx', 0o600);
      await claim.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await audit(directory, body.action, 'replay');
      sendJson(res, 409, { error: 'nonce already used' }); return true;
    }
    // Durable intent precedes any side effect; an uncertain attempt cannot be replayed.
    await audit(directory, body.action, body.dryRun ? 'dry-run-attempt' : 'apply-attempt');
    const done = await execute(body, options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), options.steerDeps);
    await audit(directory, body.action, 'completed');
    sendJson(res, 200, { v: 1, dryRun: body.dryRun, ...(done.count === undefined ? {} : { count: done.count }), ...(done.outcome === undefined ? {} : { outcome: done.outcome }) });
  } catch {
    await audit(directory, body?.action ?? 'invalid', 'unavailable').catch(() => undefined);
    sendJson(res, 503, { error: 'action unavailable' });
  }
  return true;
}
