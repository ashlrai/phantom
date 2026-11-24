import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readLeaderBoard, recordLeaderBoard } from '../src/core/fleet/leader-board.js';

it('persists distinct batch members and unknown-head conflicts, then records their falling trend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'land769-fleetcore-'));
  const now = Date.parse('2026-11-22T09:00:00Z');
  const ready = join(root, 'queue', 'ready.tsv');
  try {
    await mkdir(join(root, 'queue'));
    await writeFile(ready, [
      'READY\tRQ-REBASE-BATCH-PHANTOM-21-23-abcdef\twork\twork\texample/phantom\tFixture',
      'READY\tRQ-REBASE-PHANTOM-21-uabcdef\twork\twork\texample/phantom\tFixture',
      'PARKED-DEP.work\tRQ-REBASE-SECRETS-7-uabcdef\twork\twork\texample/secrets\tFixture',
    ].join('\n'));
    const first = await recordLeaderBoard({ runsDir: root, nowMs: now });
    expect(first.wrote).toBe(true);
    if (!first.wrote) throw new Error(first.reason);
    expect(first.board.conflictingPrs).toMatchObject({ count: 3, delta: null, trend: 'unknown' });
    expect((await readLeaderBoard({ runsDir: root })).board?.conflictingPrs.count).toBe(3);

    await writeFile(ready, 'READY\tRQ-REBASE-PHANTOM-23-uabcdef\twork\twork\texample/phantom\tFixture');
    const second = await recordLeaderBoard({ runsDir: root, nowMs: now + 60_000 });
    expect(second.wrote).toBe(true);
    const stored = await readLeaderBoard({ runsDir: root });
    expect(stored.status).toBe('ok');
    expect(stored.board?.conflictingPrs).toEqual({
      count: 1, delta: -2, trend: 'falling', history: [
        { at: new Date(now).toISOString(), count: 3 },
        { at: new Date(now + 60_000).toISOString(), count: 1 },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
