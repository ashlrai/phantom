import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkOwnerPair, pairTick, readPairState, startOwnerPair, type PairBridge, type PairInbound } from '../src/core/comms/owner-pair.js';

let configDir: string;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const bridge = (): PairBridge => ({
  ownHandles: vi.fn(async () => ['synthetic-a', 'synthetic-b']),
  baseline: vi.fn(async () => 42),
  send: vi.fn(async () => true),
  replies: vi.fn(async () => []),
});
const deps = (b: PairBridge) => ({ configDir, bridge: b, bridgeDeadlineMs: 100, now: () => 1_800_000_000_000 });
const expire = async () => { await vi.advanceTimersByTimeAsync(100); };
const snapshot = () => ['comms/owner-pair.json', 'agent-network.toml', 'comms.toml'].map(f => existsSync(join(configDir, f)) ? readFileSync(join(configDir, f), 'utf8') : null);

beforeEach(() => { vi.useFakeTimers(); configDir = mkdtempSync(join(tmpdir(), 'pair-deadline-')); });
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); rmSync(configDir, { recursive: true, force: true }); });

it.each(['discovery', 'baseline'] as const)('bounds %s without sending or writing pending state', async stage => {
  const b = bridge();
  const late = deferred<string[]>();
  const lateBaseline = deferred<number | null>();
  if (stage === 'discovery') b.ownHandles = vi.fn(() => late.promise);
  else b.baseline = vi.fn(() => lateBaseline.promise);
  const result = pairTick(deps(b));
  await expire();
  expect(await result).toEqual({ action: 'none', detail: 'messages-unreadable' });
  expect(b.send).not.toHaveBeenCalled();
  expect(readPairState(configDir).pending).toBeNull();
  const before = snapshot();
  late.resolve(['synthetic-a']); lateBaseline.reject(new Error('late baseline'));
  // The unused deferred promise has no consumer in the discovery case.
  await lateBaseline.promise.catch(() => {});
  await Promise.resolve();
  expect(snapshot()).toEqual(before);
});

it('reports uncertain first send, defers automatic retry, and ignores late rejection', async () => {
  const b = bridge();
  const late = deferred<boolean>();
  b.send = vi.fn(() => late.promise);
  const result = pairTick(deps(b));
  await expire();
  expect(await result).toEqual({ action: 'none', detail: 'send-failed; invitation delivery is uncertain; automatic retry deferred' });
  expect(readPairState(configDir).pending).toBeNull();
  const before = snapshot();
  expect(await pairTick(deps(b))).toEqual({ action: 'none', detail: 'too-soon' });
  late.reject(new Error('late send'));
  await Promise.resolve();
  expect(snapshot()).toEqual(before);
  expect(b.send).toHaveBeenCalledTimes(1);
});

it('retains the first invitation when the second send stalls', async () => {
  const b = bridge();
  const late = deferred<boolean>();
  b.send = vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(late.promise);
  const result = startOwnerPair(deps(b));
  await expire();
  expect(await result).toEqual({ status: 'pending', handles: ['synthetic-a'], since: deps(b).now(), uncertainSend: true });
  expect(readPairState(configDir).pending?.handles).toEqual(['synthetic-a']);
  const before = snapshot();
  late.resolve(true);
  await Promise.resolve();
  expect(snapshot()).toEqual(before);
});

it('leaves a stalled reply unread and checks the same cursor on a later healthy tick', async () => {
  const b = bridge();
  expect((await startOwnerPair(deps(b))).status).toBe('pending');
  const late = deferred<PairInbound[] | null>();
  b.replies = vi.fn(() => late.promise);
  const before = snapshot();
  const result = checkOwnerPair(deps(b));
  await expire();
  expect(await result).toEqual({ status: 'unreadable' });
  late.resolve([{ rowid: 43, text: 'YES', handle: 'synthetic-a' }]);
  await Promise.resolve();
  expect(snapshot()).toEqual(before);
  b.replies = vi.fn(async () => []);
  expect(await pairTick(deps(b))).toEqual({ action: 'waiting', detail: 'sent to 2 handles, waiting for YES' });
  expect(b.replies).toHaveBeenCalledWith(42, ['synthetic-a', 'synthetic-b']);
  expect(snapshot()).toEqual(before);
});
