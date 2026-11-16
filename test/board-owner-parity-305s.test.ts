/**
 * RQ-PHX-BOARDOWNERPARITY305S — owner-parity qualification for PR #5205
 * (RQ-PHX-BOARDROUTEPRESERVE165). The PR's whole diff already lives on master
 * (landed via #5293): the bounded fleet.leader-board.v1 reader folded into
 * src/core/fleet/leader-journal.ts and GET /api/fleet/board in
 * src/core/web/api.ts. These tests pin the API behavior through the real
 * handleApi dispatch against a temporary ASHLR_RUNS_DIR — no reader mocks,
 * no network, fixed clock, synthetic lanes only.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApi } from '../src/core/web/api.js';
import {
  FLEET_BOARD_SCHEMA,
  fleetBoardPath,
  fleetBoardResponse,
  readFleetBoard,
} from '../src/core/fleet/leader-journal.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const GENERATED_AT = '2026-11-13T11:57:30.000Z'; // 150 s before NOW

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'board-owner-parity-'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});

async function getBoard() {
  const req = Readable.from([]) as IncomingMessage;
  req.url = '/api/fleet/board';
  req.method = 'GET';
  req.headers = {};
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; },
    end(text: string) { payload = text; },
  } as unknown as ServerResponse;
  const handled = await handleApi(req, res, {} as AshlrConfig, { token: 'parity-test', allowDispatch: false });
  return { handled, status, body: payload ? JSON.parse(payload) : null };
}

/** Every file under runsDir as path -> text, for before/after write detection. */
async function snapshotRunsDir(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out[relative(runsDir, full)] = await readFile(full, 'utf8');
    }
  }
  await walk(runsDir);
  return out;
}

function recordedBoard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: FLEET_BOARD_SCHEMA,
    generatedAt: GENERATED_AT,
    lanes: [
      { lane: 'devin', ready: 4, parked: 1, running: 2, mergesLastHour: 3, oldestWaitSeconds: 95 },
      { lane: 'codex-cmp', ready: 'many', parked: -2, running: null, mergesLastHour: 0, oldestWaitSeconds: 'old' },
      { lane: '', ready: 9 },
      'not-a-row',
    ],
    queueDepthByTier: { frontier: 2, work: 'x', mid: -1, fast: 5 },
    mergesLastHour: 7,
    conflictingPrs: {
      count: 'unknown-count',
      delta: 2.5,
      trend: 'sideways',
      history: [
        { at: '2026-11-13T11:50:00.000Z', count: 1 },
        { at: 'not-a-date', count: 2 },
        { at: '2026-11-13T11:55:00.000Z', count: 'NaN-ish' },
      ],
    },
    needsMason: {
      status: 'available',
      count: 2,
      items: [
        { id: 'mason-1', text: 'Approve the release window' },
        { id: 'mason-2', text: 'x'.repeat(400) },
        { id: '', text: 'dropped' },
      ],
    },
    sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'missing' },
    ...overrides,
  };
}

async function writeBoard(payload: unknown): Promise<void> {
  await mkdir(join(runsDir, 'coordination'), { recursive: true });
  await writeFile(fleetBoardPath(runsDir), typeof payload === 'string' ? payload : JSON.stringify(payload));
}

describe('GET /api/fleet/board through handleApi', () => {
  it('serves a recorded fleet.leader-board.v1 payload verbatim with the shared envelope', async () => {
    await writeBoard(recordedBoard());
    const before = await snapshotRunsDir();

    const response = await getBoard();
    expect(response.handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body.schema).toBe(FLEET_BOARD_SCHEMA);
    expect(response.body.status).toBe('ok');
    expect(response.body.ageSeconds).toBe(150);
    // The tick's own generatedAt is preserved, not re-stamped by the read.
    expect(response.body.board.generatedAt).toBe(GENERATED_AT);

    // Malformed fields degrade to null/dropped, never echoed through.
    const lanes = response.body.board.lanes;
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toEqual({ lane: 'devin', ready: 4, parked: 1, running: 2, mergesLastHour: 3, oldestWaitSeconds: 95 });
    expect(lanes[1]).toEqual({ lane: 'codex-cmp', ready: null, parked: null, running: null, mergesLastHour: 0, oldestWaitSeconds: null });
    expect(response.body.board.queueDepthByTier).toEqual({ frontier: 2, fast: 5 });
    expect(response.body.board.conflictingPrs).toEqual({
      count: null,
      delta: null,
      trend: 'unknown',
      history: [{ at: '2026-11-13T11:50:00.000Z', count: 1 }],
    });
    expect(response.body.board.needsMason.status).toBe('available');
    expect(response.body.board.needsMason.items).toHaveLength(2);
    expect(response.body.board.needsMason.items[1].text).toHaveLength(300);
    expect(response.body.board.sources).toEqual({ readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'missing' });

    // The API serves exactly the projection `fleetBoardResponse` builds — the
    // same envelope contract the CLI-facing reader exposes (the only public
    // overlap: `phm fleet board` prints fleet.coordination.v1, a different
    // contract; see BRIDGE_NOTES.md).
    const direct = fleetBoardResponse(await readFleetBoard({ runsDir }), NOW.getTime());
    expect(response.body).toEqual(direct);

    // Read-only: the recording and its directory are untouched.
    expect(await snapshotRunsDir()).toEqual(before);
  });

  it('reports missing with a null board and null age when no tick recorded one', async () => {
    const before = await snapshotRunsDir();
    const response = await getBoard();
    expect(response.handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ schema: FLEET_BOARD_SCHEMA, status: 'missing', ageSeconds: null, board: null });
    // No synthesized live board: nothing is fabricated from queue sources.
    expect(response.body.board).toBeNull();
    expect(await snapshotRunsDir()).toEqual(before);
  });

  it('reports unavailable with a null board for corrupt or provenance-lost recordings', async () => {
    await writeBoard('{not json');
    let response = await getBoard();
    expect(response.body).toEqual({ schema: FLEET_BOARD_SCHEMA, status: 'unavailable', ageSeconds: null, board: null });

    // Valid JSON without the schema marker or a parseable generatedAt is not a board.
    await writeBoard({ generatedAt: GENERATED_AT, lanes: [] });
    response = await getBoard();
    expect(response.body.status).toBe('unavailable');
    expect(response.body.board).toBeNull();

    await writeBoard(recordedBoard({ generatedAt: 'not-a-date' }));
    response = await getBoard();
    expect(response.body.status).toBe('unavailable');
    expect(response.body.board).toBeNull();
  });
});
