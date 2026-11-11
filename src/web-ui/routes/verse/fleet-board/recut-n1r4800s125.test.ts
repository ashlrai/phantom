import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fleetBoardPath, fleetBoardResponse, readFleetBoard } from '../../../../core/fleet/fleet-board-read.js';

it('reads a recorded board and preserves missing and corrupt states', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'fleet-board-recut-'));
  try {
    expect(await readFleetBoard({ runsDir })).toEqual({ status: 'missing', board: null });
    const path = fleetBoardPath(runsDir);
    await mkdir(join(runsDir, 'coordination'), { recursive: true });
    await writeFile(path, JSON.stringify({ schema: 'fleet.leader-board.v1', generatedAt: '2026-11-09T12:00:00Z', lanes: [], mergesLastHour: 7 }));
    const read = await readFleetBoard({ runsDir });
    expect(read).toMatchObject({ status: 'ok', board: { mergesLastHour: 7 } });
    expect(fleetBoardResponse(read, Date.parse('2026-11-09T12:02:30Z')).ageSeconds).toBe(150);
    await writeFile(path, '{');
    expect(await readFleetBoard({ runsDir })).toEqual({ status: 'unavailable', board: null });
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
