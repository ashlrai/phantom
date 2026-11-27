import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PAIR_TTL_MS, pairTick, readPairState, startOwnerPair, unpairOwner, type PairDeps } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it.each(['fresh', 'expired history'])('persists an idle opt-out with %s', async history => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-idle-'));
  roots.push(dir);
  const now = Date.UTC(2026, 10, 26);
  const lastStartAt = history === 'fresh' ? null : now - 2 * PAIR_TTL_MS;
  if (lastStartAt !== null) {
    mkdirSync(join(dir, 'comms'));
    writeFileSync(join(dir, 'comms', 'owner-pair.json'), JSON.stringify({ pending: null, lastStartAt, autoOff: false }));
  }
  const bridge = {
    ownHandles: vi.fn(async () => ['fake-handle']),
    baseline: vi.fn(async () => 10),
    send: vi.fn(async () => true),
    replies: vi.fn(async () => []),
  };
  const deps = (): PairDeps => ({ configDir: dir, bridge, now: () => now });
  expect(unpairOwner(dir).status).toBe('not-paired');
  expect(unpairOwner(dir).status).toBe('not-paired');
  expect(readPairState(dir)).toEqual({ pending: null, lastStartAt, autoOff: true });
  expect(await pairTick(deps())).toEqual({ action: 'none', detail: 'too-soon' });
  expect(bridge.ownHandles).not.toHaveBeenCalled();
  expect(bridge.baseline).not.toHaveBeenCalled();
  expect(bridge.send).not.toHaveBeenCalled();
  expect(bridge.replies).not.toHaveBeenCalled();
  expect((await startOwnerPair(deps())).status).toBe('pending');
  expect(readPairState(dir).autoOff).toBe(false);
  expect((await pairTick(deps())).action).toBe('waiting');
  expect(bridge.send).toHaveBeenCalledTimes(1);
});
