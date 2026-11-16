import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import * as compatibility from '../src/core/fleet/fleet-board-read.js';
import * as canonical from '../src/core/fleet/leader-journal.js';

it('keeps the recovered board entry point on the canonical reader and preserves recorded evidence', async () => {
  expect(compatibility.readFleetBoard).toBe(canonical.readFleetBoard);
  expect(compatibility.fleetBoardResponse).toBe(canonical.fleetBoardResponse);
  const runsDir = await mkdtemp(join(tmpdir(), 'board-c468-'));
  try {
    await mkdir(join(runsDir, 'coordination'));
    const path = compatibility.fleetBoardPath(runsDir);
    const text = JSON.stringify({
      schema: compatibility.FLEET_BOARD_SCHEMA,
      generatedAt: '2099-01-01T00:00:00.000Z',
      lanes: [{ lane: 'example-lane', ready: 0, running: null }],
      queueDepthByTier: { work: 0 },
    });
    await writeFile(path, text);
    const response = compatibility.fleetBoardResponse(
      await compatibility.readFleetBoard({ runsDir }),
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
