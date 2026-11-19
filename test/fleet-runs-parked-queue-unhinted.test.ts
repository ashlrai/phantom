import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const now = new Date(2026, 9, 31, 12).getTime();

async function queueWith(ready: string) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-unhinted-'));
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'queue', 'ready.tsv'), ready);
  return dir;
}

describe('fleet queue lane-open rows', () => {
  it('counts open-hint rows as ready work without degrading the source or inventing a lane', async () => {
    const dir = await queueWith([
      'RQ-OPEN-A\tphantom\t\twork\t/Users/x/prompts/a.md',
      'RQ-OPEN-B\tashlrai/phantom\t\tmid\tprompts/b.md\t{"preferred_lane":null}',
      'RQ-OPEN-C\tphantom\t\tfrontier\tprompts/c.md\t{"preferred_lane":"claude"}',
      // Restock rows: the requirements spec is authoritative over the lane
      // cell — explicit null reopens the row, a named lane overrides it.
      'RQ-SPEC-OPEN\tphantom\tdevin\twork\tprompts/s1.md\t{"preferred_lane":null}',
      'RQ-SPEC-LANE\tphantom\tdevin\twork\tprompts/s2.md\t{"preferred_lane":"claude"}',
      'RQ-LANED\tphantom\tdevin\twork\t/Users/x/prompts/d.md',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      // The rows naming no lane are open market work: runnable, counted,
      // but never attributed. The requirements' preferred_lane is the honest
      // lane when it names one — ahead of the legacy lane cell.
      expect(result).toMatchObject({
        total: 6, ready: 6, parked: 0, malformed: 0, unhinted: 3,
        sources: { ready: 'healthy' },
      });
      expect(result.byLane.map((row) => row.lane)).toEqual(['claude', 'devin']);
      expect(result.nextUp?.map((row) => row.lane)).toEqual(['claude', 'devin']);
      expect(result.health?.counts.ready).toBe(6);
      expect(JSON.stringify(result)).not.toContain('/Users/');
      expect(JSON.stringify(result)).not.toContain('prompts/');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps an open-shaped row malformed when the dialect guards fail, never repo-as-lane', async () => {
    const dir = await queueWith([
      'RQ-OPEN-D\tphantom\t\twork\tprompts/d.md',
      'RQ-BADLANE\tphantom\tnot a lane!\twork\tprompts/b.md',
      'RQ-BADPROMPT\tphantom\tnot a lane!\twork\tNOEXTENSION',
      'RQ-NORMAL\tphantom\tdevin\tmid\tprompts/n.md',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      // RQ-OPEN-D is genuinely lane-open; RQ-BADLANE's lane cell is not a
      // lane id the market accepts (invalid_requirements), and RQ-BADPROMPT
      // fails the dialect's prompt guard too — neither is open supply.
      expect(result).toMatchObject({
        total: 2, ready: 2, parked: 0, malformed: 2, unhinted: 1,
        sources: { ready: 'degraded' },
      });
      expect(result.byLane.map((row) => row.lane)).toEqual(['devin']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps lane-column parked rows on their lowercase lane', async () => {
    const dir = await queueWith([
      'RQ-PARK-COL\tphantom\tPARKED-DEP.codex\twork\tprompts/p.md',
      'RQ-LANED\tphantom\tdevin\twork\tprompts/n.md',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      expect(result).toMatchObject({ total: 2, ready: 1, parked: 1, malformed: 0, unhinted: 0 });
      expect(result.byLane).toEqual([
        { lane: 'codex', ready: 0, parked: 1, phantom: 0, other: 0, otherRepos: [] },
        { lane: 'devin', ready: 1, parked: 0, phantom: 1, other: 0, otherRepos: [] },
      ]);
      expect(result.groups).toEqual([{ reason: 'DEP', lane: 'codex', count: 1, jobs: ['RQ-PARK-COL'] }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
