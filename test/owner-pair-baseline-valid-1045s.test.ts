import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pairTick, readPairState, startOwnerPair, type PairBridge } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup(baseline: number) {
  const configDir = mkdtempSync(join(tmpdir(), 'pair-baseline-'));
  roots.push(configDir);
  const bridge: PairBridge = {
    async ownHandles() { return ['synthetic-a']; },
    async baseline() { return baseline; },
    send: vi.fn(async () => true),
    async replies() { return []; },
  };
  return { deps: { configDir, bridge, now: () => 1_800_000_000_000 }, bridge, file: join(configDir, 'comms', 'owner-pair.json') };
}

it.each([NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid baseline %s without changing state', async baseline => {
  const s = setup(baseline);
  expect(await startOwnerPair(s.deps)).toEqual({ status: 'messages-unreadable' });
  expect(existsSync(s.file)).toBe(false);
  mkdirSync(join(s.deps.configDir, 'comms'));
  const prior = JSON.stringify({ pending: null, lastStartAt: 123, autoOff: true });
  writeFileSync(s.file, prior);
  expect(await startOwnerPair(s.deps)).toEqual({ status: 'messages-unreadable' });
  expect(readFileSync(s.file, 'utf8')).toBe(prior);
  expect(readPairState(s.deps.configDir).pending).toBeNull();
  expect(s.bridge.send).not.toHaveBeenCalled();
});

it('reports an invalid baseline honestly from the automatic tick', async () => {
  const s = setup(NaN);
  expect(await pairTick(s.deps)).toEqual({ action: 'none', detail: 'messages-unreadable' });
  expect(s.bridge.send).not.toHaveBeenCalled();
  expect(existsSync(s.file)).toBe(false);
});

it.each([0, 42, Number.MAX_SAFE_INTEGER])('persists valid baseline %s as a usable cursor', async baseline => {
  const s = setup(baseline);
  expect((await startOwnerPair(s.deps)).status).toBe('pending');
  expect(readPairState(s.deps.configDir).pending?.afterRowId).toBe(baseline);
  expect(s.bridge.send).toHaveBeenCalledOnce();
});
