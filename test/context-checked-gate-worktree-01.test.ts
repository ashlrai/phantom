import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runContextCheckedRun, type ContextCheckedRunOptions } from '../src/core/fleet/context-checked-run.js';
import type { LocalGateDeps } from '../src/core/fleet/local-gate.js';

let root: string, repoB: string, snapshot: string, prompt: string, errors: string;
const parent = realpathSync(process.cwd());
const sink = (write: (text: string) => void) => new Writable({ write(chunk, _encoding, done) { write(String(chunk)); done(); } });
const io = (gate: LocalGateDeps) => ({ stdout: sink(() => {}), stderr: sink(s => { errors += s; }), gate });
const worker = (marker: string, exit = 0): ContextCheckedRunOptions => ({
  snapshot, prompt,
  argv: [process.execPath, '-e', `process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},process.cwd());process.exit(${exit})})`],
});
const gate = (metricsPath: string) => {
  let time = 0;
  const exec = vi.fn(async (command: string, args: string[], _cwd: string) => {
    time++;
    return { ok: true, stdout: command === 'git' ? (args[0] === 'rev-parse' ? 'a' : 'b').repeat(40) : '', stderr: '' };
  });
  return { exec, deps: { exec, now: () => time, metricsPath } satisfies LocalGateDeps };
};

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'checked-gate-worktree-')));
  repoB = join(root, 'repository B');
  await mkdir(repoB);
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); errors = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 800 }));
  await writeFile(prompt, 'A prompt\n');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('runs the real worker and all gate steps in B while retaining isolated metrics and parent cwd', async () => {
  const marker = join(repoB, 'worker-marker');
  const metrics = join(root, 'metrics', 'gate.jsonl');
  const { exec, deps } = gate(metrics);
  expect(await runContextCheckedRun({ ...worker('worker-marker'), cwd: repoB }, io(deps))).toBe(0);
  expect(await readFile(marker, 'utf8')).toBe(repoB);
  expect(process.cwd()).toBe(parent);
  expect(exec.mock.calls).toEqual([
    ['git', ['rev-parse', 'HEAD'], repoB],
    ['git', ['merge-base', 'HEAD', 'origin/master'], repoB],
    ['node', [join(repoB, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], repoB],
    ['node', ['scripts/verify-changed.mjs'], repoB],
  ]);
  const rows = (await readFile(metrics, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { verdict: string; seconds: number });
  expect(rows).toEqual([expect.objectContaining({ verdict: 'pass', seconds: 4 })]);
  await expect(readFile(join(repoB, 'metrics', 'gate.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(errors).toBe('context-checked-run: {"workerExit":0,"gateVerdict":"pass"}\n');
});

it('captures the parent cwd when omitted and accepts an equivalent gate path', async () => {
  const marker = join(root, 'worker-marker');
  const { exec, deps } = gate(join(root, 'metrics.jsonl'));
  expect(await runContextCheckedRun(worker(marker), io({ ...deps, cwd: join(parent, '.') }))).toBe(0);
  expect(await readFile(marker, 'utf8')).toBe(parent);
  expect(exec.mock.calls).toHaveLength(4);
  expect(exec.mock.calls.every(call => call[2] === parent)).toBe(true);
  expect(process.cwd()).toBe(parent);
});

it('refuses a conflicting injected gate cwd before launching anything', async () => {
  const marker = join(root, 'worker-marker');
  const { exec, deps } = gate(join(root, 'metrics.jsonl'));
  expect(await runContextCheckedRun({ ...worker(marker), cwd: repoB }, io({ ...deps, cwd: parent }))).toBe(2);
  expect(errors).toBe('context-checked-run: gate working directory conflicts with worker\ncontext-checked-run: {"workerExit":2,"gateVerdict":"skipped"}\n');
  expect(exec).not.toHaveBeenCalled();
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(deps.metricsPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['missing', 'file', 'relative', 'empty', 'nul'])('rejects %s cwd before launching anything', async kind => {
  const marker = join(root, 'worker-marker');
  const { exec, deps } = gate(join(root, 'metrics.jsonl'));
  const cwd = { missing: join(root, 'missing'), file: prompt, relative: 'relative', empty: '', nul: '/bad\0path' }[kind]!;
  expect(await runContextCheckedRun({ ...worker(marker), cwd }, io(deps))).toBe(2);
  expect(errors).toBe('context-checked-run: invalid working directory\ncontext-checked-run: {"workerExit":2,"gateVerdict":"skipped"}\n');
  expect(exec).not.toHaveBeenCalled();
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('skips the gate when the worker exits nonzero', async () => {
  const marker = join(repoB, 'worker-marker');
  const { exec, deps } = gate(join(root, 'metrics.jsonl'));
  expect(await runContextCheckedRun({ ...worker('worker-marker', 7), cwd: repoB }, io(deps))).toBe(7);
  expect(await readFile(marker, 'utf8')).toBe(repoB);
  expect(exec).not.toHaveBeenCalled();
  expect(errors).toBe('context-checked-run: {"workerExit":7,"gateVerdict":"skipped"}\n');
  await expect(readFile(deps.metricsPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('waits for the gate and its metric append before reporting a pass', async () => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const { deps } = gate(join(root, 'metrics.jsonl'));
  const appendMetric = vi.fn(async () => { started(); await waiting; });
  const run = runContextCheckedRun({ ...worker('worker-marker'), cwd: repoB }, io({ ...deps, appendMetric }));
  try {
    await entered;
    expect(errors).toBe('');
    expect(appendMetric).toHaveBeenCalledOnce();
  } finally { release(); }
  expect(await run).toBe(0);
  expect(errors).toContain('"gateVerdict":"pass"');
});
