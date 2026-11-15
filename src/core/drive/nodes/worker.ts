import { spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkDriveExecutable } from '../script-bridge.js';
import type { JobClaim } from './index.js';
import { probeLocalModelCaps, type LocalLaneProbeDeps } from './local-model-caps.js';
import { callPool, type PoolConfig } from './pool-host.js';
import { validId } from './state.js';
import { readNodeCapacity } from './capacity.js';

/** Native sign-in checks plus the local oMLX lane plan. No auth-file reads, API tokens or output retention. */
export function probeNodeLanes(run: typeof spawnSync = spawnSync, localDeps: LocalLaneProbeDeps = {}): string[] {
  const providers = ([['codex', ['login', 'status']], ['claude', ['auth', 'status', '--json']]] as const)
    .filter(([command, args]) => {
      const result = run(command, [...args], { timeout: 5000, stdio: 'ignore',
        env: { PATH: process.env['PATH'], HOME: homedir() } });
      return !result.error && result.status === 0;
    }).map(([command]) => command);
  // Local model caps are planned, not probed: enabled config + RAM class + live headroom.
  return [...providers, ...probeLocalModelCaps(localDeps)];
}

/** Missing sentinels mean open; unreadable/unsafe control paths hold admission. */
export function nodeStopped(): boolean {
  for (const name of ['PAUSE', 'KILL']) {
    try { lstatSync(join(homedir(), '.ashlr-runs', name)); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
  }
  return false;
}

/** Trusted host runner receives references, never arbitrary commands from queue records.
 * Runner must sandbox provider work and fence any effects; it cannot publish. Diagnostics are
 * discarded. Only a bounded result reference is returned to primary custody.
 */
export async function runNodeWorker(config: PoolConfig, runner: string): Promise<Record<string, unknown>> {
  await checkDriveExecutable(runner);
  if (nodeStopped()) return { held: 'host-paused' };
  const capacity = readNodeCapacity();
  if (capacity.held) return { held: capacity.held, capacity };
  const lanes = probeNodeLanes();
  if (!lanes.length) return { held: 'no-local-provider-login' };
  const joined = callPool(config, 'join', ['--node', config.node, '--caps', lanes.join(','), '--slots', String(capacity.slots)]);
  const session = joined.result['session'];
  if (!Number.isSafeInteger(session)) return { held: 'node-already-live' };
  const identity = ['--node', config.node, '--session', String(session)];
  const attempt = async (): Promise<Record<string, unknown>> => {
    const admission = readNodeCapacity();
    if (admission.held) return { held: admission.held };
    callPool(config, 'beat', [...identity, '--usage', '0', '--slots', String(admission.slots)]);
    const pulled = callPool(config, 'pull', identity);
    if (pulled.demoted || !pulled.result['pulled']) return { pulled: false };
    const claim = pulled.result['claim'] as JobClaim;
    const job = pulled.result['job'] as { id: string; requires: string[]; secrets: string[] };
    if (!validId(job?.id) || !Array.isArray(job.requires) || !job.requires.some(c => lanes.includes(c)) ||
        job.requires.some(c => !lanes.includes(c)) || job.secrets.length || nodeStopped() || readNodeCapacity().held) return { held: 'unsupported-job' };
    const lease = [...identity, '--job', claim.jobId, '--token', String(claim.token), '--leader-token', String(claim.leaderToken)];
    // Check immediately before spawn as well as throughout execution.
    const renewed = callPool(config, 'renew', lease);
    if (!renewed.result['expiresAt'] || renewed.demoted || readNodeCapacity().held) return { held: 'lease-lost' };
    const resultRef = await new Promise<string | null>(resolve => {
      const child = spawn(runner, ['run'], { shell: false, detached: true,
        env: { PATH: process.env['PATH'], HOME: homedir() }, stdio: ['pipe', 'pipe', 'ignore'] });
      let fenced = false;
      const output: Buffer[] = [];
      let bytes = 0;
      const stop = () => {
        fenced = true;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { child.kill('SIGKILL'); }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) stop();
        else output.push(chunk);
      });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const timer = setInterval(() => {
        try {
          if (nodeStopped() || readNodeCapacity().held) return stop();
          callPool(config, 'beat', [...identity, '--usage', '1000']);
          const current = callPool(config, 'renew', lease);
          if (current.demoted || !current.result['expiresAt']) stop();
        } catch { stop(); }
      }, 3000);
      const deadline = setTimeout(stop, 30 * 60_000);
      child.on('error', () => { fenced = true; });
      child.stdin.on('error', stop);
      child.on('close', code => {
        clearInterval(timer); clearTimeout(deadline);
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        try {
          const result = JSON.parse(Buffer.concat(output).toString('utf8')) as { resultRef?: unknown };
          resolve(code === 0 && !fenced && validId(result.resultRef) ? result.resultRef : null);
        } catch { resolve(null); }
      });
      child.stdin.end(JSON.stringify({ protocol: 'phm-node-worker/v1', job: pulled.result['job'], claim }));
    });
    if (!resultRef) return { completed: false, held: 'runner-stopped' };
    const completed = callPool(config, 'complete', [...lease, '--result', resultRef]);
    return { jobId: claim.jobId, completed: completed.result['completed'] === true };
  };
  try {
    // Keep one fenced node session until every slot settles; never leave while a sibling runs.
    const settled = await Promise.allSettled(Array.from({ length: capacity.slots }, () => attempt()));
    const attempts = settled.map(result => result.status === 'fulfilled' ? result.value : { held: 'attempt-unavailable' });
    return attempts.length === 1 ? attempts[0]! : { slots: capacity.slots, attempts };
  } finally {
    try { callPool(config, 'leave', identity); } catch { /* expiry fences uncertain sessions */ }
  }
}
