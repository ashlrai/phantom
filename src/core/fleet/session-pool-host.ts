/** Host I/O adapter. The operator-owned runner retains sandbox/effect-fencing responsibility. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkDriveExecutable } from '../drive/script-bridge.js';
import { readNodeCapacity } from '../drive/nodes/capacity.js';
import { callPool, readPoolConfig } from '../drive/nodes/pool-host.js';
import { nodeStopped, probeNodeLanes } from '../drive/nodes/worker.js';
import { validId } from '../drive/nodes/state.js';
import type { JobClaim, Pulled } from '../drive/nodes/index.js';
import { privateDirectory } from '../universe/artifacts.js';
import { runSessionPool, sessionPoolPolicy, type SessionExecutor, type SessionPoolPolicy } from './session-pool.js';

/** One process per context; newline-delimited requests/results, one outstanding task. */
export function openSessionRunner(runner: string): SessionExecutor {
  const child = spawn(runner, ['session'], { detached: true, shell: false,
    env: { PATH: process.env['PATH'], HOME: homedir() }, stdio: ['pipe', 'pipe', 'ignore'] });
  let dead = false, buffer = Buffer.alloc(0);
  let pending: { task: Pulled; resolve: (ref: string) => void; reject: (error: Error) => void } | undefined;
  const close = () => {
    if (dead) return;
    dead = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    pending?.reject(new Error('Session runner stopped'));
    pending = undefined;
  };
  child.on('error', close); child.on('close', close); child.stdin.on('error', close);
  child.stdout.on('data', (chunk: Buffer) => {
    if (dead) return;
    if (!pending || buffer.length + chunk.length > 4096) return close();
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf(10);
    if (end < 0) return;
    try {
      const row = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      if (end !== buffer.length - 1 || row.protocol !== 'phm-session-worker/v1' || row.jobId !== pending.task.job.id ||
          row.token !== pending.task.claim.token || !validId(row.resultRef)) return close();
      const done = pending; pending = undefined; buffer = Buffer.alloc(0);
      done.resolve(row.resultRef);
    } catch { close(); }
  });
  return { close, run: async (task, signal) => {
    if (dead || pending || signal.aborted) throw new Error('Session runner unavailable');
    signal.addEventListener('abort', close, { once: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        pending = { task, resolve, reject };
        child.stdin.write(JSON.stringify({ protocol: 'phm-session-worker/v1', job: task.job, claim: task.claim }) + '\n');
      });
    } finally { signal.removeEventListener('abort', close); }
  } };
}

export async function runHostSessionPool(runner: string, policy: SessionPoolPolicy, signal?: AbortSignal) {
  const checked = sessionPoolPolicy(policy);
  await checkDriveExecutable(runner);
  const config = readPoolConfig();
  if (!config) throw new Error('Configure a node pool first');
  const held = () => {
    try { lstatSync(join(homedir(), '.ashlr', 'KILL')); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
    return nodeStopped() || readNodeCapacity().held !== null;
  };
  if (signal?.aborted || held()) throw new Error('Session admission held');
  const lanes = probeNodeLanes();
  if (!lanes.length) throw new Error('No local provider login');
  const rpc = (verb: string, args: string[]) => {
    const reply = callPool(config, verb, args);
    if (reply.demoted) throw new Error('Session authority lost');
    return reply.result;
  };
  const root = privateDirectory(join(homedir(), '.ashlr-runs', 'metrics'));
  const fd = openSync(join(root, 'jobs.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe session metrics');
    const joined = rpc('join', ['--node', config.node, '--caps', lanes.join(','), '--slots', '1']);
    if (!Number.isSafeInteger(joined.session)) throw new Error('Node session unavailable');
    const identity = ['--node', config.node, '--session', String(joined.session)];
    const lease = (claim: JobClaim) => [...identity, '--job', claim.jobId, '--token', String(claim.token), '--leader-token', String(claim.leaderToken)];
    return await runSessionPool({
      id: randomUUID(), now: Date.now, held,
      heartbeat: () => { rpc('beat', [...identity, '--usage', '0', '--slots', '1']); },
      pull: () => {
        const result = rpc('pull', identity);
        if (!result.pulled) return null;
        const task = result as unknown as Pulled;
        if (!validId(task.job?.id) || task.job.owner !== config.owner || task.claim?.jobId !== task.job.id ||
            task.claim.nodeId !== config.node || task.claim.session !== joined.session ||
            !Number.isSafeInteger(task.claim.token) || !Number.isSafeInteger(task.claim.leaderToken) ||
            !Array.isArray(task.job.requires) || task.job.requires.some(cap => !lanes.includes(cap)) ||
            !Array.isArray(task.job.secrets) || task.job.secrets.length) throw new Error('Unsupported session task');
        return task;
      },
      renew: claim => {
        const result = rpc('renew', lease(claim));
        return Number.isSafeInteger(result.expiresAt) ? { ...claim, expiresAt: result.expiresAt as number } : null;
      },
      complete: (claim, ref) => rpc('complete', [...lease(claim), '--result', ref]).completed === true,
      leave: () => { rpc('leave', identity); },
      open: () => openSessionRunner(runner),
      emit: event => appendFileSync(fd, JSON.stringify(event) + '\n'),
    }, checked, signal);
  } finally { closeSync(fd); }
}
