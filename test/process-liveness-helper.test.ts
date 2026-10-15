/**
 * test/helpers/process-liveness.ts: a zombie (exited, unreaped) counts as
 * terminated; a process in any other state counts as running.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { processIsRunning, waitForProcessExit } from './helpers/process-liveness.js';

function kill0(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(process.platform === 'win32')('process liveness helper', () => {
  it('treats an unreaped zombie as exited and its live parent as running', async () => {
    // `sh` backgrounds `true`, prints its pid, then execs `sleep`, which never
    // waits for children: the exited `true` stays a zombie child of `sleep`.
    const parent = spawn('/bin/sh', ['-c', 'true & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const zombiePid = await new Promise<number>((resolvePid, reject) => {
        parent.stdout.once('data', (chunk: Buffer) => resolvePid(Number(String(chunk).trim())));
        parent.once('error', reject);
      });
      expect(await waitForProcessExit(zombiePid, { timeoutMs: 3_000 })).toBe(true);
      // Still present to signal 0 (its parent has not reaped it) ...
      expect(kill0(zombiePid)).toBe(true);
      // ... but not running, while its live parent is.
      expect(processIsRunning(zombiePid)).toBe(false);
      expect(processIsRunning(parent.pid!)).toBe(true);
      expect(await waitForProcessExit(parent.pid!, { timeoutMs: 100 })).toBe(false);
    } finally {
      parent.kill('SIGKILL');
    }
    await new Promise((resolveClose) => parent.once('close', resolveClose));
    expect(await waitForProcessExit(parent.pid!)).toBe(true);
  });

  it('treats a pid with no process as exited and rejects invalid pids', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolveClose) => child.once('close', resolveClose));
    expect(processIsRunning(child.pid!)).toBe(false);
    expect(await waitForProcessExit([child.pid!], { timeoutMs: 0 })).toBe(true);
    expect(() => processIsRunning(0)).toThrow(/invalid pid/u);
    expect(() => processIsRunning(-1)).toThrow(/invalid pid/u);
  });
});
