import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const now = new Date(2026, 9, 31, 12).getTime();

async function withRuns(rows: string[], run: (result: Awaited<ReturnType<typeof readFleetQueue>>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-next-up-'));
  try {
    await mkdir(join(dir, 'queue'));
    await writeFile(join(dir, 'queue/ready.tsv'), rows.join('\n'));
    run(await readFleetQueue({ runsDir: dir, now: () => now }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('fleet queue nextUp', () => {
  it('lists the first three ready jobs per lane in file order, excluding parked rows', async () => {
    await withRuns([
      'READY\tRQ-DEV-1\tdevin\twork\tashlrai/phantom\tprompts/a.md',
      'PARKED-BYHAND.devin\tRQ-DEV-HELD\tdevin\twork\tashlrai/phantom\tprompts/b.md',
      'READY\tRQ-DEV-2\tdevin\twork\tashlrai/phantom\tprompts/c.md',
      'READY\tRQ-COD-1\tcodex-local\twork\trepo\tprompts/d.md',
      'READY\tRQ-DEV-3\tdevin\twork\tashlrai/phantom\tprompts/e.md',
      'READY\tRQ-DEV-4\tdevin\twork\tashlrai/phantom\tprompts/f.md',
      'READY\tRQ-DEV-5\tdevin\twork\tashlrai/phantom\tprompts/g.md',
    ], (result) => {
      expect(result.byLane).toEqual([
        { lane: 'codex-local', ready: 1, parked: 0, phantom: 0, other: 1, otherRepos: [] },
        { lane: 'devin', ready: 5, parked: 1, phantom: 5, other: 0, otherRepos: [] },
      ]);
      expect(result.nextUp).toEqual([
        { lane: 'codex-local', jobs: ['RQ-COD-1'] },
        { lane: 'devin', jobs: ['RQ-DEV-1', 'RQ-DEV-2', 'RQ-DEV-3'] },
      ]);
      expect(result.nextUp!.flatMap((entry) => entry.jobs)).not.toContain('RQ-DEV-HELD');
    });
  });
  it('skips malformed ready rows and omits lanes with no ready rows', async () => {
    await withRuns([
      'READY\tbad/id\tdevin\twork\trepo\tprompts/a.md',
      'PARKED-SPLIT.devin\tRQ-DEV-HELD\tdevin\twork\trepo\tprompts/b.md',
      'READY\tRQ-COD-1\tcodex-local\twork\trepo\tprompts/c.md',
    ], (result) => {
      expect(result.nextUp).toEqual([{ lane: 'codex-local', jobs: ['RQ-COD-1'] }]);
    });
  });
  it('attributes lane-column parked rows to one lane across dispatcher dialects', async () => {
    await withRuns([
      'RQ-DEV-READY\tashlrai/phantom\tdevin\twork\tprompts/a.md',
      'RQ-DEV-PARK-WORK\tashlrai/phantom\tPARKED-DEP.devin\twork\tprompts/b.md',
      'RQ-DEV-PARK-LOW\tashlrai/phantom\tPARKED-DEP.devin\tlow\tprompts/c.md',
      'PARKED-DEP.devin\tRQ-DEV-PARK-HEAD\tdevin\tmid\tashlrai/phantom\tprompts/d.md',
    ], (result) => {
      // The dialect parser uppercases the PARKED marker inside `status`; the
      // lane must still resolve to the pool cell's file-original casing so
      // header-path and dialect-path rows share one lane key.
      expect(result.byLane).toEqual([
        { lane: 'devin', ready: 1, parked: 3, phantom: 1, other: 0, otherRepos: [] },
      ]);
      expect(result.groups).toEqual([
        { reason: 'DEP', lane: 'devin', count: 3, jobs: ['RQ-DEV-PARK-HEAD', 'RQ-DEV-PARK-LOW', 'RQ-DEV-PARK-WORK'] },
      ]);
      expect(result.nextUp).toEqual([{ lane: 'devin', jobs: ['RQ-DEV-READY'] }]);
    });
  });
  it('reports an empty nextUp when nothing is ready', async () => {
    await withRuns([], (result) => {
      expect(result.nextUp).toEqual([]);
    });
  });
});
