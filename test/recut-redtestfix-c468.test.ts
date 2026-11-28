import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import {
  FLEET_BOARD_SCHEMA,
  fleetBoardPath,
  fleetBoardResponse,
  readFleetBoard,
} from '../src/core/fleet/leader-journal.js';

it('serves a recorded board through the canonical reader without rewriting it', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'board-c468-'));
  try {
    await mkdir(join(runsDir, 'coordination'));
    const path = fleetBoardPath(runsDir);
    const text = JSON.stringify({
      schema: FLEET_BOARD_SCHEMA,
      generatedAt: '2099-01-01T00:00:00.000Z',
      lanes: [{ lane: 'example-lane', ready: 0, running: null }],
      queueDepthByTier: { work: 0 },
    });
    await writeFile(path, text);
    const response = fleetBoardResponse(
      await readFleetBoard({ runsDir }),
      Date.parse('2098-12-31T23:59:59.000Z'),
    );
    expect(response.status).toBe('ok');
    expect(response.ageSeconds).toBe(0);
    expect(response.board?.lanes[0]).toMatchObject({ lane: 'example-lane', ready: 0, running: null });
    expect(response.board?.queueDepthByTier).toEqual({ work: 0 });
    expect(response.board?.mergesLastHour).toBeNull();
    expect(await readFile(path, 'utf8')).toBe(text);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
