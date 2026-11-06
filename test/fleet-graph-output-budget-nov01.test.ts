import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphArgvRun } from '../src/core/fleet/graph-argv-run.js';
let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-budget-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const argv = (code: string) => [process.execPath, '-e', `const fs=require('node:fs');${code}`];
const path = (name: string) => JSON.stringify(join(dir, name));
const touch = (name: string) => `fs.writeFileSync(${path(name)},'ok');`;
function graph(tasks: unknown[]) {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
}
// Intercepts forwarded diagnostic bytes so graph output never reaches the
// runner's own log. failEvery>0 reports an unflushed write every Nth call and
// arranges a 'drain' so the forwarder's pause/resume path is exercised.
function captureStderr(failEvery = 0) {
  const chunks: Buffer[] = [];
  let calls = 0;
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    if (failEvery && ++calls % failEvery === 0) {
      setImmediate(() => process.stderr.emit('drain'));
      return false;
    }
    return true;
  });
  return chunks;
}
const isMarker = (chunk: Buffer) => chunk.toString('latin1').includes('truncated');
const dataBytes = (chunks: Buffer[]) => Buffer.concat(chunks.filter(chunk => !isMarker(chunk))).length;
const markers = (chunks: Buffer[]) => chunks.filter(isMarker);
it('caps forwarded bytes across concurrent children on both streams, drains the rest, marks once', async () => {
  const chunks = captureStderr();
  const noisy = argv(`for(let i=0;i<300;i++){process.stdout.write('o'.repeat(997));process.stderr.write('e'.repeat(991));}`);
  const r = await graphArgvRun(graph([
    { id: 'A', argv: noisy }, { id: 'B', argv: noisy }, { id: 'C', argv: noisy },
  ]), true, 30000, 3, { outputBudgetBytes: 8192 });
  // Children wrote ~1.8MB against an 8192-byte shared budget and still
  // completed: the forwarder kept draining instead of letting pipes block.
  expect(r.status).toBe('complete');
  expect(r.nodes.map(n => n.exitCode)).toEqual([0, 0, 0]);
  expect(dataBytes(chunks)).toBe(8192);
  expect(markers(chunks).length).toBe(1);
  expect(markers(chunks)[0]!.length).toBeLessThanOrEqual(256);
  expect(process.stderr.writable).toBe(true);
  expect(process.stderr.destroyed).toBe(false);
  expect(process.stderr.writableEnded).toBe(false);
});
it('slices a single chunk at the byte boundary, even mid-codepoint', async () => {
  const chunks = captureStderr();
  // 98 'A' bytes, then a 3-byte euro sign straddling offset 98..100, then 'B's.
  const child = `process.stdout.write(Buffer.concat([Buffer.alloc(98,0x41),Buffer.from([0xE2,0x82,0xAC]),Buffer.alloc(500,0x42)]));`;
  const r = await graphArgvRun(graph([{ id: 'A', argv: argv(child) }]), true, 30000, 1, { outputBudgetBytes: 100 });
  expect(r.status).toBe('complete');
  const forwarded = Buffer.concat(chunks.filter(chunk => !isMarker(chunk)));
  expect(forwarded).toEqual(Buffer.concat([Buffer.alloc(98, 0x41), Buffer.from([0xE2, 0x82])]));
  expect(markers(chunks).length).toBe(1);
});
it('a noisy success still unblocks its dependent', async () => {
  const chunks = captureStderr();
  const r = await graphArgvRun(graph([
    { id: 'A', argv: argv(`for(let i=0;i<200;i++)process.stdout.write('x'.repeat(2048));`) },
    { id: 'B', dependsOn: ['A'], argv: argv(`${touch('B')}process.stderr.write('beep');`) },
  ]), true, 30000, 2, { outputBudgetBytes: 4096 });
  expect(r.nodes.map(n => n.status)).toEqual(['success', 'success']);
  expect(existsSync(join(dir, 'B'))).toBe(true);
  expect(dataBytes(chunks)).toBe(4096);
  expect(markers(chunks).length).toBe(1);
});
it('a noisy child that exits nonzero still reports failed', async () => {
  const chunks = captureStderr();
  const r = await graphArgvRun(graph([
    { id: 'A', argv: argv(`for(let i=0;i<100;i++)process.stderr.write('n'.repeat(4096));process.exitCode=3;`) },
  ]), true, 30000, 1, { outputBudgetBytes: 2048 });
  expect(r.nodes[0]).toMatchObject({ status: 'failed', exitCode: 3 });
  expect(dataBytes(chunks)).toBe(2048);
});
it('preview forwards no child data', async () => {
  const chunks = captureStderr();
  const r = await graphArgvRun(graph([
    { id: 'A', argv: argv(`process.stdout.write('x'.repeat(1e6));`) },
  ]), false, 30000, 2, { outputBudgetBytes: 1024 });
  expect(r.status).toBe('preview');
  expect(chunks).toEqual([]);
});
it('pauses a source under destination backpressure and resumes on drain', async () => {
  const chunks = captureStderr(2);
  const r = await graphArgvRun(graph([
    { id: 'A', argv: argv(`for(let i=0;i<200;i++)process.stderr.write('q'.repeat(2048));`) },
  ]), true, 30000, 1, { outputBudgetBytes: 16384 });
  expect(r.status).toBe('complete');
  expect(dataBytes(chunks)).toBe(16384);
  expect(markers(chunks).length).toBe(1);
});
it.each([0, -1, 262145, 1.5, Number.NaN, Infinity, '4096' as never])('rejects outputBudgetBytes=%s before spawning', async bad => {
  const chunks = captureStderr();
  const r = await graphArgvRun(graph([{ id: 'A', argv: argv(touch('nope')) }]), true, 30000, 2, { outputBudgetBytes: bad });
  expect(r.status).toBe('invalid');
  expect(existsSync(join(dir, 'nope'))).toBe(false);
  expect(chunks).toEqual([]);
});
it('accepts the minimum and maximum budgets exactly', async () => {
  let chunks = captureStderr();
  const file = graph([{ id: 'A', argv: argv(`process.stdout.write('a'.repeat(1000));`) }]);
  expect((await graphArgvRun(file, true, 30000, 1, { outputBudgetBytes: 1 })).status).toBe('complete');
  expect(dataBytes(chunks)).toBe(1);
  vi.restoreAllMocks();
  chunks = captureStderr();
  expect((await graphArgvRun(file, true, 30000, 1, { outputBudgetBytes: 262144 })).status).toBe('complete');
  expect(dataBytes(chunks)).toBe(1000);
  expect(markers(chunks)).toEqual([]);
});
