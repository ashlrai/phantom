import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { cmdFleetGraphContextRun } from '../src/cli/fleet-graph-context-run.js';
import { graphContextRun } from '../src/core/fleet/graph-context-run.js';

// The control read can be slowed deterministically so a test can place the
// shared deadline's expiry inside the readRunsSwitches await without racing it.
const harness = vi.hoisted(() => ({ controlDelayMs: 0 }));
vi.mock('../src/core/fleet/runs-switches.js', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/core/fleet/runs-switches.js')>();
  return {
    ...mod,
    readRunsSwitches: async (opts: Parameters<typeof mod.readRunsSwitches>[0] = {}) => {
      if (harness.controlDelayMs > 0) await new Promise(resolve => setTimeout(resolve, harness.controlDelayMs));
      return mod.readRunsSwitches(opts);
    },
  };
});

let root: string, runsDir: string, file: string, out: string, err: string;
const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const run = (a: string[]) =>
  cmdFleetGraphContextRun(a, { stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const io = { stderr: sink(s => { err += s; }) };
const node = (script: string, ...rest: string[]) => [process.execPath, '-e', script, ...rest];
// Every child must drain the cited pack on stdin before acting.
const end = (body: string) =>
  `const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{${body}})`;
const capture = end('fs.writeFileSync(process.argv[1],JSON.stringify({s}))');
const hang = end('fs.writeFileSync(process.argv[1],"up");setInterval(()=>{},1000)');
const marker = (name: string) => join(root, name);

const snapshot = async (jobId: string): Promise<string> => {
  const path = join(root, `snapshot-${jobId}.json`);
  await writeFile(path, JSON.stringify({
    node: { jobId, upstreamJobIds: [] },
    tasks: [{ jobId, text: `fixture task for ${jobId}` }],
    outputs: [], byteBudget: 8192,
  }));
  return path;
};
const prompt = async (id: string): Promise<string> => {
  const path = join(root, `prompt-${id}.txt`);
  await writeFile(path, `Prompt for ${id}\n`);
  return path;
};
const manifest = async (tasks: unknown[]): Promise<string> => {
  await writeFile(file, JSON.stringify({ version: 1, tasks }));
  return file;
};
const task = async (id: string, argv: string[], dependsOn?: string[]): Promise<Record<string, unknown>> =>
  ({ id, dependsOn, snapshot: await snapshot(`JOB-${id}`), prompt: await prompt(id), argv });
const waitFor = async (name: string): Promise<void> => {
  for (let i = 0; i < 1500 && !existsSync(marker(name)); i++) await new Promise(r => setTimeout(r, 10));
  if (!existsSync(marker(name))) throw new Error(`missing ${name}`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-context-budget-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  runsDir = join(root, '.ashlr-runs');
  file = join(root, 'manifest.json');
  out = ''; err = '';
  await mkdir(runsDir, { mode: 0o700 });
});
afterEach(async () => {
  harness.controlDelayMs = 0;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('fleet graph-context-run shared budget', () => {
  it('sequential work cannot multiply one shared budget', async () => {
    // Per-node budgets would let each queued node hang for the full timeoutMs;
    // one shared deadline stops the first child and every queued node stays
    // unlaunched. The killed child may still be booting — 'timeout' is the row
    // either way — while the queued nodes never launch at all.
    await manifest([
      await task('A', node(hang, marker('a.up'))),
      await task('B', node(hang, marker('b.up'))),
      await task('C', node(hang, marker('c.up'))),
    ]);
    const started = Date.now();
    const result = await graphContextRun(file, true, io, 1, { timeoutMs: 900 });
    expect(result.status).toBe('failed');
    expect(result.nodes.map(n => n.status)).toEqual(['timeout', 'deadline-exhausted', 'deadline-exhausted']);
    expect(result.nodes[0]!.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(marker('b.up'))).toBe(false);
    expect(existsSync(marker('c.up'))).toBe(false);
  });

  it('a chain shares the budget: downstream nodes never launch', async () => {
    await manifest([
      await task('A', node(hang, marker('a.up'))),
      await task('B', node(capture, marker('b.json')), ['A']),
      await task('C', node(capture, marker('c.json')), ['B']),
    ]);
    const r = await graphContextRun(file, true, io, 1, { timeoutMs: 900 });
    expect(r.status).toBe('failed');
    expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'deadline-exhausted', 'deadline-exhausted']);
    expect(existsSync(marker('b.json'))).toBe(false);
    expect(existsSync(marker('c.json'))).toBe(false);
  });

  it('a successful node still consumes the shared budget', async () => {
    await manifest([
      await task('A', node(end('setTimeout(()=>process.exit(0),150)'))),
      await task('B', node(hang, marker('b.up')), ['A']),
      await task('C', node(capture, marker('c.json')), ['B']),
    ]);
    const started = Date.now();
    const r = await graphContextRun(file, true, io, 1, { timeoutMs: 4500 });
    // B is launched with only the remainder and is stopped at the shared
    // deadline; C reports deadline-exhausted rather than blocked.
    expect(r.nodes.map(n => n.status)).toEqual(['success', 'timeout', 'deadline-exhausted']);
    expect(Date.now() - started).toBeLessThan(9000);
    expect(existsSync(marker('c.json'))).toBe(false);
  });

  it('stops and reaps every parallel active child at the deadline', async () => {
    const stubborn = (name: string) => node(end(
      'fs.writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'),
      marker(`${name}.pid`));
    await manifest([
      await task('A', stubborn('a')),
      await task('B', stubborn('b')),
      await task('C', node(capture, marker('c.json'))),
    ]);
    const running = graphContextRun(file, true, io, 2, { timeoutMs: 8000 });
    // Both children boot and record their pids first, so the run must be
    // terminating genuinely live workers — and must await their close.
    await Promise.all([waitFor('a.pid'), waitFor('b.pid')]);
    const r = await running;
    expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'timeout', 'deadline-exhausted']);
    for (const id of ['a', 'b']) {
      expect(() => process.kill(Number(readFileSync(marker(`${id}.pid`), 'utf8')), 0)).toThrow();
    }
    expect(existsSync(marker('c.json'))).toBe(false);
  });

  it('a capacity-waiting node never launches after the pinned clock expires', async () => {
    // The scheduling clock is pinned at 0 while A runs, then jumped past the
    // deadline: B, which was waiting on the concurrency=1 lane, can never start.
    let t = 0;
    await manifest([
      await task('A', node(end('fs.writeFileSync(process.argv[1],"up");setTimeout(()=>process.exit(0),400)'), marker('a.up'))),
      await task('B', node(capture, marker('b.json'))),
    ]);
    const running = graphContextRun(file, true, io, 1, { timeoutMs: 60000, now: () => t });
    await waitFor('a.up');
    t = 1e9;
    const r = await running;
    expect(r.status).toBe('failed');
    expect(r.nodes.map(n => n.status)).toEqual(['success', 'deadline-exhausted']);
    expect(existsSync(marker('b.json'))).toBe(false);
  });

  it('never launches after expiry inside the control read', async () => {
    harness.controlDelayMs = 250;
    // The deadline (200ms) expires while the slowed control read is in flight.
    await manifest([await task('A', node(capture, marker('a.json')))]);
    const r = await graphContextRun(file, true, io, 1, { timeoutMs: 200 });
    expect(r.nodes.map(n => n.status)).toEqual(['deadline-exhausted']);
    expect(existsSync(marker('a.json'))).toBe(false);
  });

  it('an already-spent budget marks every node deadline-exhausted without a child', async () => {
    await manifest([
      await task('A', node(capture, marker('a.json'))),
      await task('B', node(capture, marker('b.json')), ['A']),
    ]);
    // The first clock read fixes the deadline; every read after it lands past
    // the budget, so admission stops before any switch check or child.
    let calls = 0;
    const r = await graphContextRun(file, true, io, 1, { timeoutMs: 60000, now: () => (calls++ ? 1e9 : 0) });
    expect(r.status).toBe('failed');
    expect(r.nodes.map(n => n.status)).toEqual(['deadline-exhausted', 'deadline-exhausted']);
    expect(existsSync(marker('a.json'))).toBe(false);
    expect(existsSync(marker('b.json'))).toBe(false);
  });

  it('preview and invalid budgets spawn nothing; a valid flag completes a short graph', async () => {
    const cap = marker('cap.json');
    await manifest([await task('A', node(capture, cap))]);
    expect(await run(['--file', file, '--timeout-ms', '1', '--json'])).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'preview', nodes: [{ id: 'A', status: 'planned', exitCode: null }] });
    expect(err).toBe('');
    // In-range-shaped integers that fail core range validation report invalid.
    for (const bad of ['0', '3600001']) {
      out = '';
      expect(await run(['--file', file, '--apply', '--timeout-ms', bad])).toBe(2);
      expect((JSON.parse(out) as { status: string }).status).toBe('invalid');
    }
    // Non-integer budgets are usage errors: rejected at parse with no output row.
    for (const bad of ['-1', '1.5', 'x', '1e3']) {
      out = '';
      expect(await run(['--file', file, '--apply', '--timeout-ms', bad])).toBe(2);
      expect(out).toBe('');
    }
    out = '';
    expect(await run(['--file', file, '--apply', '--timeout-ms'])).toBe(2);
    expect(await run(['--file', file, '--apply', '--timeout-ms', '5', '--timeout-ms', '5'])).toBe(2);
    for (const bad of [0, -1, 3600001, 1.5, Number.NaN]) {
      expect((await graphContextRun(file, true, io, 1, { timeoutMs: bad })).status).toBe('invalid');
    }
    expect(existsSync(cap)).toBe(false);
    out = '';
    expect(await run(['--file', file, '--apply', '--timeout-ms', '9000'])).toBe(0);
    expect((JSON.parse(out) as { status: string }).status).toBe('complete');
    expect(existsSync(cap)).toBe(true);
  });

  it('--help documents the shared budget', async () => {
    for (const flag of ['--help', '-h']) {
      out = '';
      expect(await run([flag])).toBe(0);
      expect(out).toContain('--timeout-ms');
      expect(out).toContain('budget');
      expect(out).toContain('deadline-exhausted');
    }
    expect(await run(['--help', '--file', file])).toBe(2);
  });
});
