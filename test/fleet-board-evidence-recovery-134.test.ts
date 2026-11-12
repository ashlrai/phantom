import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi } from '../src/core/web/api.js';
import { fleetBoardPath } from '../src/core/fleet/fleet-board-read.js';
import type { AshlrConfig } from '../src/core/types.js';

const GENERATED_AT = '2026-11-11T03:00:00.000Z';
const BOARD = {
  schema: 'fleet.leader-board.v1',
  generatedAt: GENERATED_AT,
  lanes: [{ lane: 'devin', ready: 2, parked: 1, running: 3, mergesLastHour: 4, oldestWaitSeconds: 60 }],
  queueDepthByTier: { work: 2 },
  mergesLastHour: 4,
  conflictingPrs: { count: 1, delta: -1, trend: 'falling', history: [{ at: '2026-11-11T02:00:00.000Z', count: 2 }] },
  needsMason: { status: 'available', count: 1, items: [{ id: 'nm-test0001', text: 'approve fixture' }] },
  sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' },
};

type BoardResponse = {
  schema: string;
  status: string;
  ageSeconds: number | null;
  board: {
    generatedAt: string;
    lanes: Array<{ lane: string; ready: number | null }>;
    mergesLastHour: number | null;
    needsMason: { count: number };
  } | null;
};
let runsDir = '';
let previousRunsDir: string | undefined;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'fleet-board-api-'));
  previousRunsDir = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runsDir;
  await mkdir(join(runsDir, 'coordination'), { recursive: true });
});

afterEach(async () => {
  if (previousRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRunsDir;
  await rm(runsDir, { recursive: true, force: true });
});
async function getBoard(): Promise<{ status: number; body: BoardResponse }> {
  const req = { url: '/api/fleet/board', method: 'GET', headers: {} } as IncomingMessage;
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; },
    end(chunk?: string) { payload = chunk ?? ''; },
  } as unknown as ServerResponse;
  expect(await handleApi(req, res, {} as AshlrConfig, { token: 'test', allowDispatch: false })).toBe(true);
  return { status, body: JSON.parse(payload) as BoardResponse };
}

describe('GET /api/fleet/board', () => {
  it('serves the recorded Leader board in the fleet board envelope', async () => {
    await writeFile(fleetBoardPath(runsDir), JSON.stringify(BOARD));
    const { status, body } = await getBoard();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['ageSeconds', 'board', 'schema', 'status']);
    expect(body).toMatchObject({ schema: 'fleet.leader-board.v1', status: 'ok' });
    expect(body.ageSeconds).toEqual(expect.any(Number));
    expect(body.board).toMatchObject({ generatedAt: GENERATED_AT, mergesLastHour: 4, needsMason: { count: 1 } });
    expect(body.board?.lanes[0]).toMatchObject({ lane: 'devin', ready: 2 });
  });

  it('reports missing, corrupt, oversized and symlinked recordings honestly', async () => {
    const path = fleetBoardPath(runsDir);
    expect((await getBoard()).body.status).toBe('missing');

    await writeFile(path, 'not json{');
    expect((await getBoard()).body.status).toBe('unavailable');

    await writeFile(path, 'x'.repeat(300 * 1024));
    expect((await getBoard()).body.status).toBe('unavailable');

    await rm(path);
    const target = join(runsDir, 'real-board.json');
    await writeFile(target, JSON.stringify(BOARD));
    await symlink(target, path, 'file');
    expect((await getBoard()).body.status).toBe('unavailable');
  });
});
