import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pairTick, readPairState, startOwnerPair, unpairOwner, type PairDeps } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const configDir = mkdtempSync(join(tmpdir(), 'pair-inflight-'));
  roots.push(configDir);
  const bridge = {
    ownHandles: vi.fn(async () => ['one@example.test', 'two@example.test']),
    baseline: vi.fn(async () => 10 as number | null),
    send: vi.fn(async (_handle: string, _text: string) => true),
    replies: vi.fn(async () => []),
  };
  const deps: PairDeps = { configDir, bridge, now: () => 1000 };
  return { configDir, bridge, deps };
}

it.each(['ownHandles', 'baseline'] as const)('honors unpair while %s is suspended', async stage => {
  const { configDir, bridge, deps } = setup();
  const gate = deferred<void>();
  const entered = deferred<void>();
  if (stage === 'ownHandles') bridge.ownHandles.mockImplementation(async () => { entered.resolve(); await gate.promise; return ['one@example.test']; });
  else bridge.baseline.mockImplementation(async () => { entered.resolve(); await gate.promise; return 10; });
  const start = startOwnerPair(deps, { auto: true });
  await entered.promise;
  unpairOwner(configDir);
  gate.resolve();
  expect((await start).status).toBe('too-soon');
  expect(bridge.send).not.toHaveBeenCalled();
  expect(readPairState(configDir)).toEqual({ pending: null, lastStartAt: null, autoOff: true });
  expect((await pairTick(deps)).action).toBe('none');
  expect(bridge.send).not.toHaveBeenCalled();
});

it('stops further sends and preserves unpair while a send is in flight', async () => {
  const { configDir, bridge, deps } = setup();
  const gate = deferred<boolean>();
  const entered = deferred<void>();
  bridge.send.mockImplementation(async () => { entered.resolve(); return gate.promise; });
  const start = startOwnerPair(deps, { auto: true });
  await entered.promise;
  unpairOwner(configDir);
  gate.resolve(true);
  expect((await start).status).toBe('too-soon');
  expect(bridge.send).toHaveBeenCalledTimes(1);
  expect(readPairState(configDir)).toEqual({ pending: null, lastStartAt: null, autoOff: true });
  expect((await pairTick(deps)).action).toBe('none');
  expect(bridge.send).toHaveBeenCalledTimes(1);
});

it('starts normally and manual pairing opts back in', async () => {
  const { configDir, bridge, deps } = setup();
  expect((await startOwnerPair(deps, { auto: true })).status).toBe('pending');
  expect(bridge.send).toHaveBeenCalledTimes(2);
  unpairOwner(configDir);
  expect((await startOwnerPair(deps)).status).toBe('pending');
  expect(readPairState(configDir).autoOff).toBe(false);
});
