/**
 * core/fleet/fleet-board-read.ts — the console's bounded reader for
 * <runs>/coordination/leader-board.json (schema fleet.leader-board.v1).
 * Everything runs against a temp runs dir; the parser never throws.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLEET_BOARD_SCHEMA,
  fleetBoardDigest,
  fleetBoardPath,
  fleetBoardResponse,
  parseFleetBoard,
  readFleetBoard,
  type FleetBoardV1,
} from '../src/core/fleet/fleet-board-read.js';

const dirs: string[] = [];
function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-board-read-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BOARD: FleetBoardV1 = {
  schema: 'fleet.leader-board.v1',
  generatedAt: '2026-11-07T12:00:00.000Z',
  lanes: [
    { lane: 'claude', ready: 4, parked: 1, running: 2, mergesLastHour: 3, oldestWaitSeconds: 540 },
    { lane: 'devin', ready: 0, parked: 0, running: 1, mergesLastHour: null, oldestWaitSeconds: null },
  ],
  queueDepthByTier: { frontier: 2, work: 5, mid: 1, unknown: 1 },
  mergesLastHour: 3,
  conflictingPrs: {
    count: 2,
    delta: 1,
    trend: 'rising',
    history: [
      { at: '2026-11-07T11:00:00.000Z', count: 1 },
      { at: '2026-11-07T12:00:00.000Z', count: 2 },
    ],
  },
  needsMason: { status: 'available', count: 1, items: [{ id: 'nm-abc123def456', text: 'approve the domain renewal' }] },
  sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' },
};

function writeBoard(dir: string, payload: unknown = BOARD): string {
  const path = fleetBoardPath(dir);
  mkdirSync(join(dir, 'coordination'), { recursive: true });
  writeFileSync(path, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return path;
}

describe('parseFleetBoard', () => {
  it('round-trips a recorded board', () => {
    expect(parseFleetBoard(JSON.stringify(BOARD))).toEqual(BOARD);
  });

  it('rejects non-json, non-objects, wrong schema and unparseable generatedAt', () => {
    for (const raw of ['', 'not json{', '[1]', 'null', '"x"', '{}',
      JSON.stringify({ schema: 'other.v1', generatedAt: BOARD.generatedAt }),
      JSON.stringify({ schema: FLEET_BOARD_SCHEMA, generatedAt: 'not a date' }),
      JSON.stringify({ schema: FLEET_BOARD_SCHEMA }),
    ]) {
      expect(parseFleetBoard(raw), raw).toBeNull();
    }
  });

  it('keeps unknown measurements null and drops malformed entries', () => {
    const parsed = parseFleetBoard(JSON.stringify({
      ...BOARD,
      lanes: [
        { lane: 'claude', ready: 'x', parked: -1, running: 2, mergesLastHour: 0, oldestWaitSeconds: 'soon' },
        { lane: '', ready: 1 },
        { noLane: true },
        'junk',
      ],
      mergesLastHour: 'many',
      conflictingPrs: {
        count: -2,
        delta: 1.5,
        trend: 'sideways',
        history: [
          { at: '2026-11-07T11:00:00.000Z', count: 1 },
          { at: 'never', count: 1 },
          { at: '2026-11-07T12:00:00.000Z', count: 'two' },
          'noise',
        ],
      },
      needsMason: { status: 'bogus', items: [{ id: 'ok-id', text: 'real' }, { text: 'no id' }, { id: 'x', text: '' }], count: 'x' },
      sources: { readyTsv: 'mystery', queueCounts: 'degraded', needsMason: 'gone' },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.lanes).toEqual([
      { lane: 'claude', ready: null, parked: null, running: 2, mergesLastHour: 0, oldestWaitSeconds: null },
    ]);
    expect(parsed!.mergesLastHour).toBeNull();
    expect(parsed!.conflictingPrs).toEqual({
      count: null,
      delta: null,
      trend: 'unknown',
      history: [{ at: '2026-11-07T11:00:00.000Z', count: 1 }],
    });
    expect(parsed!.needsMason).toEqual({ status: 'unavailable', count: 1, items: [{ id: 'ok-id', text: 'real' }] });
    expect(parsed!.sources).toEqual({ readyTsv: 'degraded', queueCounts: 'unavailable', needsMason: 'unavailable' });
  });

  it('queueDepthByTier stays null only when the recording wrote null', () => {
    expect(parseFleetBoard(JSON.stringify({ ...BOARD, queueDepthByTier: null }))!.queueDepthByTier).toBeNull();
    expect(parseFleetBoard(JSON.stringify({ ...BOARD, queueDepthByTier: { work: 3, bad: 'x', '': 1 } }))!.queueDepthByTier)
      .toEqual({ work: 3 });
    expect(parseFleetBoard(JSON.stringify({ ...BOARD, queueDepthByTier: 'deep' }))!.queueDepthByTier).toBeNull();
  });
});

describe('readFleetBoard', () => {
  it('reads a written board from <runs>/coordination/leader-board.json', async () => {
    const dir = runsDir();
    writeBoard(dir);
    const result = await readFleetBoard({ runsDir: dir });
    expect(result).toEqual({ status: 'ok', board: BOARD });
  });

  it('reports missing when no tick has recorded one', async () => {
    const result = await readFleetBoard({ runsDir: runsDir() });
    expect(result).toEqual({ status: 'missing', board: null });
  });

  it('reports unavailable for a corrupt or oversized recording, and refuses a symlink', async () => {
    const corrupt = runsDir();
    writeBoard(corrupt, 'not json{');
    expect((await readFleetBoard({ runsDir: corrupt })).status).toBe('unavailable');

    const linked = runsDir();
    const target = join(corrupt, 'real.json');
    writeFileSync(target, JSON.stringify(BOARD));
    mkdirSync(join(linked, 'coordination'), { recursive: true });
    symlinkSync(target, fleetBoardPath(linked));
    expect((await readFleetBoard({ runsDir: linked })).status).toBe('unavailable');
  });
});

describe('fleetBoardDigest', () => {
  it('returns a fingerprint that changes with the file, and null when absent', async () => {
    const dir = runsDir();
    expect(await fleetBoardDigest({ runsDir: dir })).toBeNull();
    writeBoard(dir);
    const first = await fleetBoardDigest({ runsDir: dir });
    expect(first).not.toBeNull();
    writeBoard(dir, { ...BOARD, mergesLastHour: 9 });
    const second = await fleetBoardDigest({ runsDir: dir });
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe('fleetBoardResponse', () => {
  it('matches the phm fleet board --json envelope: schema, status, ageSeconds, board', () => {
    const now = Date.parse('2026-11-07T12:02:30.000Z');
    expect(fleetBoardResponse({ status: 'ok', board: BOARD }, now)).toEqual({
      schema: FLEET_BOARD_SCHEMA,
      status: 'ok',
      ageSeconds: 150,
      board: BOARD,
    });
    expect(fleetBoardResponse({ status: 'missing', board: null }, now)).toEqual({
      schema: FLEET_BOARD_SCHEMA,
      status: 'missing',
      ageSeconds: null,
      board: null,
    });
  });

  it('never reports a negative age when the clock lags the recording', () => {
    const early = Date.parse('2026-11-07T11:59:00.000Z');
    expect(fleetBoardResponse({ status: 'ok', board: BOARD }, early).ageSeconds).toBe(0);
  });
});
