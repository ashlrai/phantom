import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readLeaderBoard, recordLeaderBoard } from '../src/core/fleet/leader-board.js';

it('records distinct batch members across parked rows and leaves unavailable evidence unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'board-batch-780s-'));
  const ready = join(root, 'queue', 'ready.tsv');
  const now = Date.parse('2026-11-22T09:00:00Z');
  try {
    await mkdir(join(root, 'queue'));
    await writeFile(ready, [
      '# RQ-REBASE-BATCH-PHANTOM-90-91-abcdef',
      'READY\tRQ-REBASE-BATCH-PHANTOM-1-2-abcdef\twork\twork',
      'READY\tRQ-REBASE-PHANTOM-1-abcdef0\twork\twork',
      'PARKED-DEP.work\tRQ-REBASE-BATCH-SECRETS-2-3-abcdef\twork\twork',
      'RQ-REBASE-BATCH-PHANTOM-2-4-abcdef\trepo\tPARKED-DEP.work\twork',
      'READY\tRQ-REBASE-BATCH-PHANTOM-5-6-abcdef0\twork\twork',
      'READY\tRQ-REBASE-BATCH-PHANTOM-7-8-abcdef-suffix\twork\twork',
      'READY\tRQ-REBASE-PHANTOM-9-uabcdef0\twork\twork',
    ].join('\n'));
    expect((await recordLeaderBoard({ runsDir: root, nowMs: now })).wrote).toBe(true);
    expect((await readLeaderBoard({ runsDir: root })).board?.conflictingPrs).toMatchObject({ count: 5, delta: null, trend: 'unknown' });
    await writeFile(ready, 'READY\tRQ-REBASE-PHANTOM-2-uabcdef\twork\twork');
    expect((await recordLeaderBoard({ runsDir: root, nowMs: now + 1000 })).wrote).toBe(true);
    expect((await readLeaderBoard({ runsDir: root })).board?.conflictingPrs).toMatchObject({ count: 1, delta: -4, trend: 'falling' });
    await unlink(ready);
    expect((await recordLeaderBoard({ runsDir: root, nowMs: now + 2000 })).wrote).toBe(true);
    const board = (await readLeaderBoard({ runsDir: root })).board;
    expect(board?.conflictingPrs).toMatchObject({ count: null, delta: null, trend: 'unknown' });
    expect(board?.conflictingPrs.history.map(sample => sample.count)).toEqual([5, 1]);
    expect(board?.sources.readyTsv).toBe('missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
