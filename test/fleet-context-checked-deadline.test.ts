import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextCheckedRun } from '../src/cli/fleet-context-checked-run.js';
import type { LocalGateDeps } from '../src/core/fleet/local-gate.js';

let root: string, snapshot: string, prompt: string, out: string, err: string;
const args = (flags: string[], script: string) => [
  '--snapshot', snapshot, '--prompt', prompt, ...flags, '--', process.execPath, '-e', script,
];
const streams = (gate: LocalGateDeps) => ({
  stdout: new Writable({ write(c, _e, done) { out += String(c); done(); } }),
  stderr: new Writable({ write(c, _e, done) { err += String(c); done(); } }),
  gate,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checked-deadline-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); out = ''; err = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 800 }));
  await writeFile(prompt, 'Prompt\n');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('stops a real stuck worker at its deadline and skips the gate', async () => {
  const pidFile = join(root, 'worker.pid');
  const exec = vi.fn();
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000)`;
  let exited = false;
  try {
    expect(await cmdFleetContextCheckedRun(args(['--timeout-ms', '10000'], script), streams({ exec }))).toBe(124);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    exited = true;
    expect(exec).not.toHaveBeenCalled();
    expect(err).toContain('context-checked-run: {"workerExit":124,"gateVerdict":"skipped"}\n');
  } finally {
    if (!exited && existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already exited */ }
    }
  }
}, 60000);

it('waits for one gate after a successful worker with a deadline', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const gateEntered = new Promise<void>(resolve => { entered = resolve; });
  const exec = vi.fn(async (command: string) => {
    entered(); await blocked;
    return { ok: true, stdout: command === 'git' ? 'a'.repeat(40) : '', stderr: '' };
  });
  const appendMetric = vi.fn(async () => {});
  let settled = false;
  const done = cmdFleetContextCheckedRun(args(['--timeout-ms', '3600000', '--budget-seconds', '180'],
    'process.stdin.resume()'), streams({ exec, appendMetric })).then(code => { settled = true; return code; });
  try {
    await Promise.race([gateEntered, done.then(code => { throw new Error(`worker finished before gate: ${code}`); })]);
    expect(settled).toBe(false);
    expect(err).not.toContain('context-checked-run:');
  } finally { release(); }
  expect(await done).toBe(0);
  expect(exec).toHaveBeenCalledTimes(4);
  expect(appendMetric).toHaveBeenCalledTimes(1);
  expect(err).toContain('context-checked-run: {"workerExit":0,"gateVerdict":"pass"}\n');
}, 30000);

it('rejects malformed deadlines before spawning or running the gate', async () => {
  const marker = join(root, 'spawned');
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`;
  const exec = vi.fn();
  const bad = [[], ['1', '--timeout-ms', '2'], ['0'], ['-1'], ['3600001'], ['9007199254740992'],
    ['1.5'], ['Infinity'], ['NaN'], ['1e3'], ['+1'], [' 1'], ['1\0'], ['']];
  for (const values of bad) {
    err = '';
    expect(await cmdFleetContextCheckedRun(args(['--timeout-ms', ...values], script), streams({ exec })), JSON.stringify(values)).toBe(2);
    expect(err).toContain('Usage: ashlr fleet context-checked-run');
    expect(existsSync(marker)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  }
});

it('documents the separate worker deadline and gate budget', async () => {
  const exec = vi.fn();
  expect(await cmdFleetContextCheckedRun(['--help'], streams({ exec }))).toBe(0);
  expect(out).toContain('--timeout-ms <1..3600000>');
  expect(out).toContain('--timeout-ms limits the worker; --budget-seconds limits the local gate.');
  expect(exec).not.toHaveBeenCalled();
});
