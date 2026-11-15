import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLeaderStatusSnapshot, renderLeaderStatus, summarizeQueueRollup } from '../src/core/comms/leader-status-snapshot.js';

const status = (by_lane: unknown, merged?: unknown) => ({ rollup_24h: { by_lane, merged } });

describe('leader rollup evidence', () => {
  it('leaves absent, empty and invalid evidence unknown', () => {
    expect(summarizeQueueRollup(null).merged24h).toBeNull();
    expect(summarizeQueueRollup(status({})).merged24h).toBeNull();
    for (const merged of [null, -1, 1.5, NaN, Infinity, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(summarizeQueueRollup(status({ devin: { merged } }, merged)).merged24h).toBeNull();
    }
  });

  it('retains valid lanes while refusing incomplete totals', () => {
    const result = summarizeQueueRollup(status({ devin: { merged: null }, claude: { merged: 3 } }));
    expect(result.merged24h).toBeNull();
    expect(result.lanes).toEqual([{ lane: 'claude', merged: 3, medianTtmS: null }]);
    expect(summarizeQueueRollup(status({ devin: {}, claude: { merged: 3 } }, 7)).merged24h).toBe(7);
  });

  it('infers complete zero and positive totals', () => {
    expect(summarizeQueueRollup(status({ a: { merged: 0 }, b: { merged: 0 } })).merged24h).toBe(0);
    expect(summarizeQueueRollup(status({ a: { merged: 2 }, b: { merged: 3 } })).merged24h).toBe(5);
    expect(summarizeQueueRollup(status({ a: { merged: Number.MAX_SAFE_INTEGER }, b: { merged: 1 } })).merged24h).toBeNull();
  });

  it('does not infer from a truncated lane projection', () => {
    const lanes = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`lane${i}`, { merged: 1 }]));
    expect(summarizeQueueRollup(status(lanes))).toMatchObject({ merged24h: null, lanes: expect.any(Array) });
    expect(summarizeQueueRollup(status(lanes)).lanes).toHaveLength(16);
    expect(summarizeQueueRollup(status(lanes, 17)).merged24h).toBe(17);
  });
});

describe('leader status from a real source', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
  it('renders incomplete evidence as unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'leader-partial-')); roots.push(root);
    mkdirSync(join(root, 'queue'));
    writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify(status({ devin: { merged: null } })));
    const snapshot = await readLeaderStatusSnapshot({ runsDir: root });
    expect(snapshot.merged24h).toBeNull();
    expect(renderLeaderStatus(snapshot)).toContain('Merged PRs in the last 24h: unknown');
    expect(renderLeaderStatus(snapshot)).not.toContain('Merged PRs in the last 24h: 0');
  });
});
