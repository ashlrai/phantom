import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busWakeQueueEnqueue, busWakeQueuePath, enqueueBusWake, readBusWakes } from '../src/core/fleet/bus-wake-queue.js';
const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'wake-')); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach(value => rmSync(value, { recursive: true, force: true })));
const request = { kind: 'bus.send' as const, id: 'fake-id', from: 'mason', to: 'leaders', body: 'fake interjection' };
it('durably queues only routing fields and deduplicates IDs', () => {
  const opts = { root: root(), now: () => 42 };
  expect(readBusWakes(opts).state).toBe('missing');
  expect(enqueueBusWake(request, opts)).toBe('queued');
  expect(enqueueBusWake(request, opts)).toBe('duplicate');
  const row = { kind: 'bus.send', id: 'fake-id', from: 'mason', to: 'leaders', at: 42 };
  expect(readBusWakes(opts)).toEqual({ state: 'ok', wakes: [row], matched: 1, truncated: false });
  expect(JSON.parse(readFileSync(busWakeQueuePath(opts.root), 'utf8'))).toEqual(row);
  appendFileSync(busWakeQueuePath(opts.root), 'malformed\n');
  expect(readBusWakes(opts).wakes).toEqual([row]);
  expect(readBusWakes({ ...opts, sinceAt: 42 }).wakes).toEqual([]);
  expect(() => enqueueBusWake(request, { ...opts, maxBytes: 1 })).toThrow();
});
it('rejects an already aborted wake without writing', async () => {
  const directory = root();
  await expect(busWakeQueueEnqueue(directory)(request, AbortSignal.abort())).rejects.toThrow();
  expect(readBusWakes({ root: directory }).state).toBe('missing');
});
it('compacts to the observable tail at the byte cap instead of failing forever', () => {
  let tick = 0;
  const opts = { root: root(), now: () => ++tick, maxBytes: 700 };
  // Each row is ~80 bytes; the cap holds about eight. Every send must stay queued.
  for (let i = 0; i < 30; i++) {
    expect(enqueueBusWake({ kind: 'bus.send', id: `wake-${i}`, from: 'mason', to: 'leaders' }, opts)).toBe('queued');
  }
  expect(statSync(busWakeQueuePath(opts.root)).size).toBeLessThanOrEqual(700);
  const wakes = readBusWakes(opts).wakes;
  expect(wakes.length).toBeGreaterThan(0);
  expect(wakes.at(-1)).toMatchObject({ id: 'wake-29', at: 30 });
  const kept = new Set(wakes.map(wake => wake.id));
  expect(kept.has('wake-0')).toBe(false); // dropped: beyond the retained window
  expect(kept.has('wake-29')).toBe(true);
  // A retained id still deduplicates; a dropped id re-queues like any new hint.
  expect(enqueueBusWake({ kind: 'bus.send', id: 'wake-29', from: 'mason', to: 'leaders' }, opts)).toBe('duplicate');
  expect(enqueueBusWake({ kind: 'bus.send', id: 'wake-0', from: 'mason', to: 'leaders' }, opts)).toBe('queued');
});
it('does not rewrite the queue for a duplicate at the cap', () => {
  let tick = 0;
  const opts = { root: root(), now: () => ++tick, maxBytes: 700 };
  for (let i = 0; i < 12; i++) {
    enqueueBusWake({ kind: 'bus.send', id: `d-${i}`, from: 'mason', to: 'leaders' }, opts);
  }
  const before = readFileSync(busWakeQueuePath(opts.root));
  expect(enqueueBusWake({ kind: 'bus.send', id: 'd-11', from: 'mason', to: 'leaders' }, opts)).toBe('duplicate');
  expect(readFileSync(busWakeQueuePath(opts.root))).toEqual(before);
});
it('refuses a row larger than the whole budget without touching stored wakes', () => {
  const directory = root();
  enqueueBusWake(request, { root: directory, now: () => 1 });
  const before = readFileSync(busWakeQueuePath(directory));
  expect(() => enqueueBusWake({ ...request, id: 'other-id' }, { root: directory, now: () => 2, maxBytes: 10 })).toThrow();
  expect(readFileSync(busWakeQueuePath(directory))).toEqual(before);
});
it('reports matched totals and truncation instead of silently capping the page', () => {
  const opts = { root: root(), now: () => 7 };
  for (const [id, to] of [['w-1', 'leaders'], ['w-2', 'agent:nova'], ['w-3', 'leaders'], ['w-4', 'agent:nova']] as const) {
    enqueueBusWake({ kind: 'bus.send', id, from: 'mason', to }, opts);
  }
  // The match predicate filters before the cap: matched counts every accepted
  // row in the observable tail, wakes keeps only the newest `limit` of them.
  const page = readBusWakes({ ...opts, limit: 1, match: row => row.to === 'leaders' });
  expect(page).toMatchObject({ state: 'ok', matched: 2, truncated: true });
  expect(page.wakes.map(row => row.id)).toEqual(['w-3']);
  const all = readBusWakes(opts);
  expect(all).toMatchObject({ state: 'ok', matched: 4, truncated: false });
  expect(all.wakes).toHaveLength(4);
  // sinceAt composes with match: only newer accepted rows count as matched.
  expect(readBusWakes({ ...opts, sinceAt: 7, match: row => row.to === 'leaders' }))
    .toMatchObject({ matched: 0, truncated: false, wakes: [] });
});
it('bounds the page by beforeAt — exclusive, composing with sinceAt into (since, before)', () => {
  let tick = 0;
  const opts = { root: root(), now: () => ++tick };
  for (const [id, to] of [['b-1', 'leaders'], ['b-2', 'agent:nova'], ['b-3', 'leaders'], ['b-4', 'agent:nova']] as const) {
    enqueueBusWake({ kind: 'bus.send', id, from: 'mason', to }, opts);
  }
  // at runs 1..4 in enqueue order; beforeAt is exclusive — a row stamped
  // exactly at it never matches, the mirror of sinceAt's lower bound.
  const page = readBusWakes({ ...opts, beforeAt: 3 });
  expect(page).toMatchObject({ state: 'ok', matched: 2, truncated: false });
  expect(page.wakes.map(row => row.id)).toEqual(['b-1', 'b-2']);
  // The pair reads one (sinceAt, beforeAt) window on the hint's queue time.
  const window = readBusWakes({ ...opts, sinceAt: 1, beforeAt: 4 });
  expect(window).toMatchObject({ state: 'ok', matched: 2 });
  expect(window.wakes.map(row => row.id)).toEqual(['b-2', 'b-3']);
  // matched counts accepted rows before the row cap, same as sinceAt.
  expect(readBusWakes({ ...opts, beforeAt: 4, limit: 1, match: row => row.to === 'leaders' }))
    .toMatchObject({ state: 'ok', matched: 2, truncated: true });
});
it('marks the read truncated when older bytes sit beyond the bounded tail window', () => {
  const directory = root();
  enqueueBusWake(request, { root: directory, now: () => 1 });
  // Valid rows carrying an ignored pad field push the file past the 256 KiB
  // observation window, so the oldest bytes — including the first hint —
  // become unobservable. matched is then a lower bound, never a proven total.
  const pad = 'x'.repeat(16 * 1024);
  const lines = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ kind: 'bus.send', id: `pad-${i}`, from: 'mason', to: 'leaders', at: i + 2, pad }) + '\n').join('');
  appendFileSync(busWakeQueuePath(directory), lines);
  const read = readBusWakes({ root: directory });
  expect(read.state).toBe('ok');
  expect(read.truncated).toBe(true);
  expect(read.matched).not.toBeNull();
  expect(read.matched!).toBeLessThan(21);
  expect(read.wakes.length).toBeLessThanOrEqual(500);
});
