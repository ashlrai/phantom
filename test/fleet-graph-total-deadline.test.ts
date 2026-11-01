import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphArgvRun } from '../src/core/fleet/graph-argv-run.js';
import { cmdFleetGraphRun } from '../src/cli/fleet-graph-run.js';

// The control read is slowed to a deterministic 250ms so tests can place the
// shared deadline's expiry inside the readRunsSwitches await without racing it.
vi.mock('../src/core/fleet/runs-switches.js', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/core/fleet/runs-switches.js')>();
  return {
    ...mod,
    readRunsSwitches: async (opts: Parameters<typeof mod.readRunsSwitches>[0] = {}) => {
      await new Promise(resolve => setTimeout(resolve, 250));
      return mod.readRunsSwitches(opts);
    },
  };
});

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-deadline-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const path = (name: string) => JSON.stringify(join(dir, name));
const argv = (code: string) => [process.execPath, '-e', `const fs=require('node:fs');${code}`];
const touch = (name: string) => `fs.writeFileSync(${path(name)},'ok');`;
const hang = (name: string) => `${touch(name)}setInterval(()=>{},1000);`;
const sleepThenExit = (ms: number) => `setTimeout(()=>process.exit(0),${ms});`;
function graph(tasks: unknown[]) {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
}
async function waitFor(name: string) {
  const deadline = Date.now() + 15000;
  while (!existsSync(join(dir, name))) {
    if (Date.now() > deadline) throw Error(`missing ${name}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it('sequential work cannot multiply one shared budget', async () => {
  const file = graph(['A', 'B', 'C'].map(id => ({ id, argv: argv(hang(id)) })));
  const started = Date.now();
  const r = await graphArgvRun(file, true, 500);
  const elapsed = Date.now() - started;
  // One budget spent once: the first child is stopped at the deadline and the
  // queued nodes never launch instead of each spending a fresh timeoutMs.
  expect(r.status).toBe('failed');
  expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'deadline-exhausted', 'deadline-exhausted']);
  expect(elapsed).toBeLessThan(1300);
  expect(existsSync(join(dir, 'B'))).toBe(false);
  expect(existsSync(join(dir, 'C'))).toBe(false);
});

it('a chain shares the budget: downstream nodes never launch', async () => {
  const file = graph([
    { id: 'A', argv: argv(hang('A')) },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('B')) },
    { id: 'C', dependsOn: ['B'], argv: argv(touch('C')) },
  ]);
  const started = Date.now();
  const r = await graphArgvRun(file, true, 600);
  const elapsed = Date.now() - started;
  expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'deadline-exhausted', 'deadline-exhausted']);
  expect(elapsed).toBeLessThan(1500);
  expect(existsSync(join(dir, 'B'))).toBe(false);
  expect(existsSync(join(dir, 'C'))).toBe(false);
});

it('a successful node still consumes the shared budget', async () => {
  const file = graph([
    { id: 'A', argv: argv(`${touch('A')}${sleepThenExit(200)}`) },
    { id: 'B', dependsOn: ['A'], argv: argv(hang('B')) },
    { id: 'C', dependsOn: ['B'], argv: argv(touch('C')) },
  ]);
  const started = Date.now();
  const r = await graphArgvRun(file, true, 8000);
  const elapsed = Date.now() - started;
  // A succeeds inside the budget; B is launched with only the remainder and is
  // stopped at the shared deadline; C is never started. With per-node timeouts
  // B would have run a fresh 8s and C would have ended blocked, not exhausted.
  expect(r.nodes.map(n => n.status)).toEqual(['success', 'timeout', 'deadline-exhausted']);
  expect(elapsed).toBeLessThan(10000);
  expect(existsSync(join(dir, 'B'))).toBe(true);
  expect(existsSync(join(dir, 'C'))).toBe(false);
});

it('stops and reaps every parallel active child at the deadline', async () => {
  const stubborn = (name: string) => argv(`fs.writeFileSync(${path(`${name}.pid`)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const file = graph([
    { id: 'A', argv: stubborn('A') },
    { id: 'B', argv: stubborn('B') },
    { id: 'C', argv: argv(touch('C')) },
    { id: 'D', dependsOn: ['A'], argv: argv(touch('D')) },
  ]);
  const running = graphArgvRun(file, true, 4500, 2);
  // Both children boot, record their pids, then are stopped at one deadline.
  await Promise.all([waitFor('A.pid'), waitFor('B.pid')]);
  const r = await running;
  expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'timeout', 'deadline-exhausted', 'deadline-exhausted']);
  // Awaiting close means both pids are gone (SIGKILL after the 250ms grace).
  for (const id of ['A', 'B']) {
    expect(() => process.kill(Number(readFileSync(join(dir, `${id}.pid`), 'utf8')), 0)).toThrow();
  }
  expect(existsSync(join(dir, 'C'))).toBe(false);
  expect(existsSync(join(dir, 'D'))).toBe(false);
});

it('never launches after expiry inside the control read', async () => {
  const file = graph([{ id: 'A', argv: argv(touch('A')) }]);
  // The deadline (200ms) expires while the 250ms control read is in flight.
  const r = await graphArgvRun(file, true, 200);
  expect(r.nodes.map(n => n.status)).toEqual(['deadline-exhausted']);
  expect(existsSync(join(dir, 'A'))).toBe(false);
});

it('an already-spent budget marks every node deadline-exhausted', async () => {
  const file = graph(['A', 'B'].map(id => ({ id, argv: argv(touch(id)) })));
  const r = await graphArgvRun(file, true, 1);
  expect(r.nodes.map(n => n.status)).toEqual(['deadline-exhausted', 'deadline-exhausted']);
  expect(existsSync(join(dir, 'A'))).toBe(false);
  expect(existsSync(join(dir, 'B'))).toBe(false);
});

it('completes a short graph inside one budget', async () => {
  const file = graph([
    { id: 'A', argv: argv(touch('A')) },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('B')) },
    { id: 'C', argv: argv(touch('C')) },
  ]);
  const r = await graphArgvRun(file, true, 15000, 2);
  expect(r.status).toBe('complete');
  expect(r.nodes.map(n => n.status)).toEqual(['success', 'success', 'success']);
  for (const id of ['A', 'B', 'C']) expect(existsSync(join(dir, id))).toBe(true);
});

it('preview has zero effects even with a spent budget', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const file = graph([{ id: 'A', argv: argv(touch('A')) }]);
  const r = await graphArgvRun(file, false, 1);
  expect(r).toEqual({ status: 'preview', nodes: [{ id: 'A', status: 'planned', exitCode: null }] });
  expect(await cmdFleetGraphRun(['--file', file, '--timeout-ms', '1'])).toBe(0);
  expect(existsSync(join(dir, 'A'))).toBe(false);
});

it('cancellation delivered during the control read still wins', async () => {
  const file = graph([{ id: 'A', argv: argv(touch('A')) }]);
  const running = graphArgvRun(file, true, 30000);
  const signal = setTimeout(() => process.emit('SIGINT'), 50);
  const r = await running;
  clearTimeout(signal);
  expect(r.nodes.map(n => n.status)).toEqual(['cancelled']);
  expect(existsSync(join(dir, 'A'))).toBe(false);
});

it('cancellation beats timeout for active children and queued nodes', async () => {
  const before = process.listenerCount('SIGINT');
  const file = graph([
    { id: 'A', argv: argv(`fs.writeFileSync(${path('A.pid')},String(process.pid));setInterval(()=>{},1000);`) },
    { id: 'B', argv: argv(touch('B')) },
  ]);
  const running = graphArgvRun(file, true, 30000);
  try { await waitFor('A.pid'); }
  finally { process.emit('SIGINT'); }
  const r = await running;
  expect(r.nodes.map(n => n.status)).toEqual(['cancelled', 'cancelled']);
  expect(() => process.kill(Number(readFileSync(join(dir, 'A.pid'), 'utf8')), 0)).toThrow();
  expect(existsSync(join(dir, 'B'))).toBe(false);
  expect(process.listenerCount('SIGINT')).toBe(before);
});

it('dependency failure semantics are preserved before the deadline', async () => {
  const file = graph([
    { id: 'A', argv: argv('process.exit(7)') },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('B')) },
    { id: 'C', argv: argv(touch('C')) },
  ]);
  const r = await graphArgvRun(file, true, 15000, 2);
  const byId = new Map(r.nodes.map(n => [n.id, n]));
  expect(byId.get('A')).toMatchObject({ status: 'failed', exitCode: 7 });
  expect(byId.get('B')).toMatchObject({ status: 'blocked', exitCode: null });
  expect(byId.get('C')).toMatchObject({ status: 'success', exitCode: 0 });
  expect(existsSync(join(dir, 'B'))).toBe(false);
});

it('--help describes the shared budget and the concurrency bound', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetGraphRun(['--help'])).toBe(0);
  expect(await cmdFleetGraphRun(['-h'])).toBe(0);
  const text = log.mock.calls.map(call => String(call[0])).join('\n');
  expect(text).toContain('--timeout-ms');
  expect(text).toContain('budget');
  expect(text).toContain('--concurrency');
  const file = graph([{ id: 'A', argv: argv(touch('A')) }]);
  expect(await cmdFleetGraphRun(['--help', '--file', file])).toBe(2);
  expect(existsSync(join(dir, 'A'))).toBe(false);
});
