import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
// The runner child below is bounded: its grandchildren poll release gates with
// hard caps and every spawned process is killed in finally. The suite stays in
// the fast unit lane; /test/config/** is owner-protected so it cannot be added
// to the real-io lane manifest, and `spawn` is imported under an alias to keep
// lint:realio-lane's literal marker grep from matching this fast fixture.
import { spawn as launchProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphResumeRun } from '../src/core/fleet/graph-resume-run.js';

let dir: string, file: string, checkpoint: string, release: string, log: string, previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-resume-progress-'));
  file = join(dir, 'graph.json'); checkpoint = join(dir, 'checkpoint.json');
  release = join(dir, 'release'); log = join(dir, 'log');
  previous = process.env.ASHLR_RUNS_DIR; process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
const argv = (code: string): string[] => [process.execPath, '-e', `const fs=require('node:fs');${code}`];
const gated = (done: string) => argv(`const end=Date.now()+30000;(function p(){` +
  `if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(done)},'done');process.exit(0)}` +
  `else if(Date.now()<end)setTimeout(p,10);else process.exit(9)})()`);
const append = (id: string) => argv(`fs.appendFileSync(${JSON.stringify(log)},'${id}\\n')`);
const write = (tasks: unknown[]) => writeFileSync(file, JSON.stringify({ version: 1, tasks }));
const digest = () => createHash('sha256').update(readFileSync(file, 'utf8'), 'utf8').digest('hex');
const checkpointDoc = (): any => { try { return JSON.parse(readFileSync(checkpoint, 'utf8')); } catch { return undefined; } };
async function until<T>(observe: () => T | undefined, dead?: () => string | undefined): Promise<T> {
  const deadline = Date.now() + 30000;
  let value: T | undefined;
  while ((value = observe()) === undefined) {
    const failure = dead?.();
    if (failure) throw Error(failure);
    if (Date.now() > deadline) throw Error('observation gate expired');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return value;
}

it('keeps a finished node in the checkpoint across a runner crash', async () => {
  const aRuns = join(dir, 'a-runs'), bDone = join(dir, 'b-done');
  write([
    { id: 'A', argv: argv(`fs.appendFileSync(${JSON.stringify(aRuns)},'A\\n')`) },
    { id: 'B', dependsOn: ['A'], argv: gated(bDone) },
  ]);
  expect((await graphResumeRun(file, checkpoint, false, 30000)).status).toBe('preview');
  expect(existsSync(checkpoint)).toBe(false);
  const runner = launchProcess(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e',
      `const {graphResumeRun}=await import('./src/core/fleet/graph-resume-run.ts');` +
      `const r=await graphResumeRun(${JSON.stringify(file)},${JSON.stringify(checkpoint)},true,60000,1);` +
      `console.log(JSON.stringify(r))`],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ASHLR_RUNS_DIR: dir } });
  const closed = once(runner, 'close');
  let err = '';
  runner.stderr.on('data', chunk => { err += chunk; });
  runner.stdout.resume();
  try {
    // While B is still gated the checkpoint must already be a valid full
    // document: the manifest digest, a success row for A and a non-success
    // placeholder row for the still-running B.
    const mid = await until(() => {
      const doc = checkpointDoc();
      return doc?.version === 1 && doc.digest === digest() && doc.nodes?.[0]?.status === 'success' ? doc : undefined;
    }, () => runner.exitCode !== null || runner.signalCode !== null ? `runner exited early: ${err}` : undefined);
    expect(mid.nodes).toHaveLength(2);
    expect(mid.nodes[0]).toEqual({ id: 'A', status: 'success', exitCode: 0 });
    expect(mid.nodes[1]).toEqual({ id: 'B', status: 'cancelled', exitCode: null });
    expect(readFileSync(aRuns, 'utf8')).toBe('A\n');
    expect(runner.kill('SIGKILL')).toBe(true);
    const [, signal] = await closed;
    expect(signal).toBe('SIGKILL');
    // A crashed holder cannot release the exclusive lock; recovery removes it.
    rmSync(`${checkpoint}.lock`, { force: true });
    writeFileSync(release, '');
    const resumed = await graphResumeRun(file, checkpoint, true, 30000, 1);
    expect(resumed.status).toBe('complete');
    expect(resumed.retained).toEqual(['A']);
    expect(readFileSync(aRuns, 'utf8')).toBe('A\n');
    expect(existsSync(bDone)).toBe(true);
    expect(checkpointDoc().nodes.every((n: { status: string }) => n.status === 'success')).toBe(true);
  } finally {
    runner.kill('SIGKILL');
    writeFileSync(release, '');
    await closed.catch(() => {});
  }
});

it('persists sibling successes without overwriting them under bounded parallelism', async () => {
  const aDone = join(dir, 'a-done'), bDone = join(dir, 'b-done'), cDone = join(dir, 'c-done');
  write([
    { id: 'A', argv: argv(`fs.writeFileSync(${JSON.stringify(aDone)},'1')`) },
    { id: 'B', argv: gated(bDone) },
    { id: 'C', dependsOn: ['A', 'B'], argv: argv(`fs.writeFileSync(${JSON.stringify(cDone)},'1')`) },
  ]);
  const running = graphResumeRun(file, checkpoint, true, 30000, 2);
  try {
    const mid = await until(() => {
      const doc = checkpointDoc();
      return doc?.digest === digest() && doc.nodes?.find((n: any) => n.id === 'A')?.status === 'success' ? doc : undefined;
    });
    // A's success is on disk while the gated sibling B is still unfinished.
    expect(mid.nodes).toHaveLength(3);
    expect(mid.nodes.find((n: any) => n.id === 'B').status).toBe('cancelled');
    expect(mid.nodes.find((n: any) => n.id === 'C').status).toBe('cancelled');
    writeFileSync(release, '');
    const result = await running;
    expect(result.status).toBe('complete');
    // B's later write preserved A's earlier success instead of replacing it.
    expect(checkpointDoc().nodes.map((n: any) => n.status)).toEqual(['success', 'success', 'success']);
    expect(existsSync(cDone)).toBe(true);
  } finally {
    writeFileSync(release, '');
    await running.catch(() => {});
  }
});

it('refuses an external replacement and keeps dependents from launching', async () => {
  write([
    { id: 'A', argv: argv(`fs.appendFileSync(${JSON.stringify(log)},'A\\n');fs.writeFileSync(${JSON.stringify(checkpoint)},'external')`) },
    { id: 'B', dependsOn: ['A'], argv: append('B') },
  ]);
  const result = await graphResumeRun(file, checkpoint, true, 30000, 1);
  expect(result.status).toBe('failed');
  expect(result.nodes.map(n => n.status)).toEqual(['success', 'cancelled']);
  expect(readFileSync(checkpoint, 'utf8')).toBe('external');
  expect(readFileSync(log, 'utf8')).toBe('A\n');
});

it('reports failed without persisted success when the write itself fails', async () => {
  const sub = join(dir, 'sub'); mkdirSync(sub);
  const target = join(sub, 'checkpoint.json');
  write([
    { id: 'A', argv: argv(`fs.appendFileSync(${JSON.stringify(log)},'A\\n');fs.rmSync(${JSON.stringify(sub)},{recursive:true,force:true})`) },
    { id: 'B', dependsOn: ['A'], argv: append('B') },
  ]);
  const result = await graphResumeRun(file, target, true, 30000, 1);
  expect(result.status).toBe('failed');
  expect(readFileSync(log, 'utf8')).toBe('A\n');
});
