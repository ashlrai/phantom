/**
 * scripts/run-bounded-command.mjs: a process group whose only remaining
 * members are unreaped zombies has exited, even though kill(-pgid, 0) still
 * succeeds. Containers whose init reaps orphans late or never (`docker run`
 * without --init) leave a killed descendant in exactly that state.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { processGroupExists } from '../scripts/run-bounded-command.mjs';

function state(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.charAt(stat.lastIndexOf(') ') + 2);
}

describe.runIf(process.platform === 'linux')('bounded command process-group liveness', () => {
  it('counts a zombie-only group as exited and a group with a live member as present', async () => {
    // The backgrounded `setsid` execs in place (a job is not a group leader),
    // so `$!` leads its own group. It then sleeps (live) or exits (zombie);
    // its parent execs `sleep`, which never reaps, so the zombie persists.
    const run = (body: string) => spawn('/bin/sh', ['-c', `setsid /bin/sh -c '${body}' & echo $!; exec sleep 5`],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const pidOf = (child: ReturnType<typeof run>) => new Promise<number>((resolvePid, reject) => {
      child.stdout!.once('data', (chunk: Buffer) => resolvePid(Number(String(chunk).trim())));
      child.once('error', reject);
    });
    const zombieParent = run('exit 0');
    const liveParent = run('sleep 5');
    let liveLeader = 0;
    try {
      const zombieLeader = await pidOf(zombieParent);
      liveLeader = await pidOf(liveParent);
      const deadline = Date.now() + 3_000;
      while (state(zombieLeader) !== 'Z' && Date.now() < deadline) await delay(10);
      expect(state(zombieLeader)).toBe('Z');
      expect(() => process.kill(-zombieLeader, 0)).not.toThrow();
      expect(processGroupExists({ pid: zombieLeader })).toBe(false);

      expect(state(liveLeader)).not.toBe('Z');
      expect(processGroupExists({ pid: liveLeader })).toBe(true);
    } finally {
      if (liveLeader > 0) try { process.kill(-liveLeader, 'SIGKILL'); } catch { /* already gone */ }
      for (const child of [zombieParent, liveParent]) child.kill('SIGKILL');
    }
  });
});
