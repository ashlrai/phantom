import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphArgvRun, type GraphArgvNodeResult } from '../src/core/fleet/graph-argv-run.js';
import { cmdFleetGraphRun } from '../src/cli/fleet-graph-run.js';

const seam = vi.hoisted(() => ({ beforeRead: async () => {}, afterRead: () => {} }));
vi.mock('../src/core/fleet/runs-switches.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/runs-switches.js')>();
  return { ...actual, readRunsSwitches: async () => {
    await seam.beforeRead();
    const result = await actual.readRunsSwitches();
    seam.afterRead();
    return result;
  } };
});

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-fail-fast-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previous;
  seam.beforeRead = async () => {};
  seam.afterRead = () => {};
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
const path = (name: string) => join(dir, name);
const touch = (name: string) => `fs.writeFileSync(${JSON.stringify(path(name))},'ok');`;
const argv = (code: string) => [process.execPath, '-e', `const fs=require('node:fs');${code}`];
const waitFor = (name: string, code: string) => `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path(name))})){clearInterval(t);${code}}},10);`;
function graph(tasks: unknown[]) {
  const file = path('graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

it.each([true, false])('serial failure with failFast=%s preserves rows and callbacks', async failFast => {
  const rows: GraphArgvNodeResult[] = [];
  const file = graph([
    { id: 'failure', argv: argv('process.exit(7)') },
    { id: 'independent', argv: argv(touch('marker')) },
    { id: 'dependent', dependsOn: ['failure'], argv: argv(touch('dependent')) },
    { id: 'descendant', dependsOn: ['dependent'], argv: argv(touch('descendant')) },
  ]);
  const result = await graphArgvRun(file, true, 15000, 1, { failFast, onNodeTerminal: row => { rows.push(row); } });
  expect(result.status).toBe('failed');
  expect(result.nodes).toEqual([
    { id: 'failure', status: 'failed', exitCode: 7 },
    { id: 'independent', status: failFast ? 'fail-fast-skipped' : 'success', exitCode: failFast ? null : 0 },
    { id: 'dependent', status: 'blocked', exitCode: null },
    { id: 'descendant', status: 'blocked', exitCode: null },
  ]);
  expect(rows).toHaveLength(result.nodes.length);
  expect(new Map(rows.map(row => [row.id, row]))).toEqual(new Map(result.nodes.map(row => [row.id, row])));
  expect(existsSync(path('marker'))).toBe(!failFast);
  expect(existsSync(path('dependent')) || existsSync(path('descendant'))).toBe(false);
});

it('lets a running sibling finish while skipping queued work', async () => {
  const rows: GraphArgvNodeResult[] = [];
  const file = graph([
    { id: 'failure', argv: argv(waitFor('running', 'process.exit(7);')) },
    { id: 'running', argv: argv(`${touch('running')}${waitFor('release', touch('finished'))}`) },
    { id: 'queued', argv: argv(touch('queued')) },
    { id: 'dependent', dependsOn: ['failure'], argv: argv(touch('dependent')) },
  ]);
  const result = await graphArgvRun(file, true, 15000, 2, { failFast: true, onNodeTerminal: row => {
    rows.push(row);
    if (row.id === 'failure') writeFileSync(path('release'), '');
  } });
  expect(result.status).toBe('failed');
  expect(result.nodes.map(row => [row.id, row.status, row.exitCode])).toEqual([
    ['failure', 'failed', 7], ['running', 'success', 0], ['queued', 'fail-fast-skipped', null], ['dependent', 'blocked', null],
  ]);
  expect(rows).toHaveLength(4);
  expect(new Map(rows.map(row => [row.id, row]))).toEqual(new Map(result.nodes.map(row => [row.id, row])));
  expect(existsSync(path('finished'))).toBe(true);
  expect(existsSync(path('queued')) || existsSync(path('dependent'))).toBe(false);
});

it('observes a failure during a switch read even while its callback is pending', async () => {
  const inRead = deferred(), releaseRead = deferred(), readDone = deferred(), inCallback = deferred(), releaseCallback = deferred();
  let reads = 0;
  seam.beforeRead = async () => { if (++reads === 2) { inRead.resolve(); await releaseRead.promise; } };
  seam.afterRead = () => { if (reads === 2) readDone.resolve(); };
  const file = graph([
    { id: 'failure', argv: argv('process.exit(7)') },
    { id: 'queued', argv: argv(touch('queued')) },
  ]);
  const rows: GraphArgvNodeResult[] = [];
  const running = graphArgvRun(file, true, 15000, 2, { failFast: true, onNodeTerminal: async row => {
    rows.push(row);
    if (row.id === 'failure') { inCallback.resolve(); await releaseCallback.promise; }
  } });
  try {
    await Promise.all([inRead.promise, inCallback.promise]);
    releaseRead.resolve();
    await readDone.promise;
    await new Promise(resolve => setImmediate(resolve));
  } finally { releaseRead.resolve(); releaseCallback.resolve(); }
  const result = await running;
  expect(result.nodes.map(row => row.status)).toEqual(['failed', 'fail-fast-skipped']);
  expect(rows).toEqual(result.nodes);
  expect(existsSync(path('queued'))).toBe(false);
});

it('retains callback rejection halt semantics', async () => {
  const rows: string[] = [];
  const file = graph([{ id: 'first', argv: argv('') }, { id: 'next', argv: argv(touch('next')) }]);
  const result = await graphArgvRun(file, true, 15000, 1, { failFast: true, onNodeTerminal: row => {
    rows.push(row.id);
    if (row.id === 'first') throw Error('callback failed');
  } });
  expect(result.status).toBe('failed');
  expect(result.nodes.map(row => row.status)).toEqual(['success', 'cancelled']);
  expect(rows).toEqual(['first', 'next']);
  expect(existsSync(path('next'))).toBe(false);
});

it('accepts the CLI flag in preview and apply, rejects duplicates, and documents it', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const file = graph([{ id: 'failure', argv: argv('process.exit(7)') }, { id: 'next', argv: argv(touch('next')) }]);
  expect(await cmdFleetGraphRun(['--file', file, '--fail-fast'])).toBe(0);
  expect(JSON.parse(String(log.mock.lastCall?.[0])).status).toBe('preview');
  expect(existsSync(path('next'))).toBe(false);
  expect(await cmdFleetGraphRun(['--file', file, '--fail-fast', '--fail-fast'])).toBe(2);
  expect(await cmdFleetGraphRun(['--file', file, '--apply', '--fail-fast'])).toBe(1);
  expect(JSON.parse(String(log.mock.lastCall?.[0])).nodes[1].status).toBe('fail-fast-skipped');
  expect(existsSync(path('next'))).toBe(false);
  expect(await cmdFleetGraphRun(['--help'])).toBe(0);
  expect(String(log.mock.lastCall?.[0])).toContain('--fail-fast stops new launches');
});
