import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pairTick, readPairState, startOwnerPair, type PairBridge } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'pair-flight-')); roots.push(d); return d; };
afterEach(() => roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const bridge = (discovery: Promise<string[]>): PairBridge => ({
  ownHandles: vi.fn(() => discovery), baseline: vi.fn(async () => 7),
  send: vi.fn(async () => true), replies: vi.fn(async () => []),
});

it('shares overlapping automatic starts, including ticks and equivalent paths', async () => {
  const configDir = dir();
  const found = deferred<string[]>();
  const fake = bridge(found.promise);
  const first = startOwnerPair({ configDir, bridge: fake }, { auto: true });
  const second = pairTick({ configDir: join(configDir, '.'), bridge: fake });
  expect(fake.ownHandles).toHaveBeenCalledTimes(1);
  found.resolve(['fake@example.com']);
  expect((await first).status).toBe('pending');
  expect((await second).action).toBe('started');
  expect(fake.baseline).toHaveBeenCalledTimes(1);
  expect(fake.send).toHaveBeenCalledTimes(1);
  expect(readPairState(configDir).pending?.handles).toEqual(['fake@example.com']);
});

it('allows independent directories to start concurrently', async () => {
  const found = deferred<string[]>();
  const fake = bridge(found.promise);
  const first = startOwnerPair({ configDir: dir(), bridge: fake }, { auto: true });
  const second = startOwnerPair({ configDir: dir(), bridge: fake }, { auto: true });
  expect(fake.ownHandles).toHaveBeenCalledTimes(2);
  found.resolve(['fake@example.com']);
  expect((await Promise.all([first, second])).map(r => r.status)).toEqual(['pending', 'pending']);
  expect(fake.send).toHaveBeenCalledTimes(2);
});

it('releases the flight after an exception or a negative result', async () => {
  const configDir = dir();
  const fake = bridge(Promise.resolve(['fake@example.com']));
  vi.mocked(fake.ownHandles).mockRejectedValueOnce(new Error('fake bridge')).mockResolvedValueOnce([]);
  await expect(startOwnerPair({ configDir, bridge: fake })).rejects.toThrow('fake bridge');
  expect((await startOwnerPair({ configDir, bridge: fake })).status).toBe('none-found');
  expect((await startOwnerPair({ configDir, bridge: fake })).status).toBe('pending');
});
