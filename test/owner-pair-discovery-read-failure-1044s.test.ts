import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pairTick, readPairState, startOwnerPair, type PairBridge, type PairDeps } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup(failure: 'discovery' | 'baseline') {
  const dir = mkdtempSync(join(tmpdir(), 'pair-read-'));
  roots.push(dir);
  writeFileSync(join(dir, 'agent-network.toml'), '[mason]\nidentities = []\n');
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = false\n');
  let unavailable = true;
  const ownHandles = vi.fn(async () => {
    if (unavailable && failure === 'discovery') throw new Error('sentinel-private-error');
    return ['test-handle'];
  });
  const baseline = vi.fn(async () => {
    if (unavailable && failure === 'baseline') throw new Error('sentinel-private-error');
    return 10;
  });
  const send = vi.fn(async () => true);
  const bridge: PairBridge = { ownHandles, baseline, send, async replies() { return []; } };
  const deps: PairDeps = { configDir: dir, bridge, now: () => 100_000 };
  const snapshot = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]);
  return { dir, deps, ownHandles, baseline, send, snapshot, recover: () => { unavailable = false; } };
}

describe('owner pairing read failures', () => {
  for (const failure of ['discovery', 'baseline'] as const) {
    it(`reports a rejected ${failure} from start without changing state`, async () => {
      const s = setup(failure);
      const before = s.snapshot();
      const result = await startOwnerPair(s.deps);
      expect(result).toEqual({ status: 'messages-unreadable' });
      expect(JSON.stringify(result)).not.toContain('sentinel-private-error');
      expect(s.send).not.toHaveBeenCalled();
      expect(s.snapshot()).toEqual(before);
      expect(readPairState(s.dir)).toEqual({ pending: null, lastStartAt: null, autoOff: false });
    });

    it(`reports a rejected ${failure} on the tick and recovers on the next tick`, async () => {
      const s = setup(failure);
      const before = s.snapshot();
      const result = await pairTick(s.deps);
      expect(result).toEqual({ action: 'none', detail: 'Messages discovery or baseline is unreadable; invitation not sent' });
      expect(JSON.stringify(result)).not.toMatch(/sentinel-private-error|test-handle/);
      expect(s.send).not.toHaveBeenCalled();
      expect(s.snapshot()).toEqual(before);
      expect(readPairState(s.dir)).toEqual({ pending: null, lastStartAt: null, autoOff: false });
      s.recover();
      expect((await pairTick(s.deps)).action).toBe('started');
      expect(s.send).toHaveBeenCalledTimes(1);
    });
  }

  it('bypasses discovery for an explicit handle but still requires a readable baseline', async () => {
    const s = setup('baseline');
    s.ownHandles.mockRejectedValue(new Error('sentinel-private-error'));
    const before = s.snapshot();
    expect(await startOwnerPair(s.deps, { handle: 'explicit-test' })).toEqual({ status: 'messages-unreadable' });
    expect(s.ownHandles).not.toHaveBeenCalled();
    expect(s.baseline).toHaveBeenCalledOnce();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
    expect(readPairState(s.dir)).toEqual({ pending: null, lastStartAt: null, autoOff: false });
    s.recover();
    expect((await startOwnerPair(s.deps, { handle: 'explicit-test' })).status).toBe('pending');
    expect(s.ownHandles).not.toHaveBeenCalled();
    expect(s.send).toHaveBeenCalledTimes(1);
  });
});
