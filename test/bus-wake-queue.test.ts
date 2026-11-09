import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  expect(readBusWakes(opts)).toEqual({ state: 'ok', wakes: [row] });
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
