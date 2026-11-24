/**
 * Owner-proof edge matrix for `phm lanes --json` (RQ-PHX-LANEOBSOWNERQUALIFY303S),
 * qualifying PR #5206 head 88cc590b8e4c8345cfc602f0292e9c32ec7e1c45.
 * Exercises the real cmdLanes against real temporary `.ashlr-runs/queue/status.json`
 * files: measured zeros stay zero, unmeasured usage stays null, and malformed or
 * missing status degrades the source without inventing lastTick. No mocks of the
 * code under test; the only stub is the unrelated live-snapshot API used by `health`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-13T00:00:00.000Z', commit: 'abc1234', lanes: [], runs: [] } })),
}));

import { cmdLanes } from '../src/cli/lanes.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const HEADER = {
  last_tick: '2026-11-13T15:00:00Z',
  paused: null,
  mem_free_pct: 40,
  schema: 'dispatchd.status.v1',
};

async function homeWithFiles(files: Record<string, string>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lane-obs-303s-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  vi.stubEnv('HOME', root);
}

const statusFile = (status: unknown) => ({
  '.ashlr-runs/queue/status.json': typeof status === 'string' ? status : JSON.stringify(status),
});

async function lanesJson(): Promise<{ text: string; report: Record<string, any> }> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdLanes(['--json'])).toBe(0);
  const text = out.mock.calls.at(-1)![0] as string;
  return { text, report: JSON.parse(text) };
}

describe('phm lanes --json owner proof edge matrix (RQ-PHX-LANEOBSOWNERQUALIFY303S)', () => {
  it('keeps measured running/target/queued zero as zero and null bounds as null', async () => {
    await homeWithFiles(statusFile({ ...HEADER, lanes: {
      'zero-lane': { running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true },
      'null-bounds': { running: 1, target: 3, queued: 2, floor: null, ceiling: null, held: false },
    } }));
    const { report } = await lanesJson();
    expect(report.sourceState).toBe('healthy');
    expect(report.lastTick).toBe('2026-11-13T15:00:00Z');
    const lanes = Object.fromEntries(report.lanes.map((l: { lane: string }) => [l.lane, l]));
    expect(lanes['zero-lane']).toMatchObject({ running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true });
    expect(lanes['null-bounds']).toMatchObject({ running: 1, target: 3, queued: 2, floor: null, ceiling: null });
  });

  it('keeps absent usage null rather than inventing zero when metrics are missing', async () => {
    await homeWithFiles(statusFile({ ...HEADER, lanes: {
      'usage-unknown': { running: 2, target: 4, queued: 1, floor: null, ceiling: null, held: false },
    } }));
    const { report } = await lanesJson();
    const lane = report.lanes.find((l: { lane: string }) => l.lane === 'usage-unknown');
    expect(lane.tokensLastHour).toBeNull();
    expect(lane.merged24h).toBeNull();
    expect(lane.mergeRate24h).toBeNull();
    // The status source itself is healthy; only usage stayed unmeasured.
    expect(report.sourceState).toBe('healthy');
  });

  it('reports degraded with no invented lastTick when status.json is malformed JSON', async () => {
    await homeWithFiles(statusFile('{not json'));
    const { report } = await lanesJson();
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('degraded');
  });

  it('reports degraded with no invented lastTick when status.json fails schema validation', async () => {
    for (const bad of [
      { paused: null, mem_free_pct: 40, schema: 'dispatchd.status.v1', lanes: {} }, // no last_tick
      { last_tick: '2026-11-13T15:00:00Z', paused: null, mem_free_pct: 40, schema: 'dispatchd.status.v1', lanes: [] }, // lanes not object
      { last_tick: 'not-a-timestamp', paused: null, mem_free_pct: 40, schema: 'dispatchd.status.v1', lanes: {} },
      'null', '[]', '"text"',
    ]) {
      await homeWithFiles(statusFile(bad));
      const { report } = await lanesJson();
      expect(report.lanes).toEqual([]);
      expect(report.lastTick).toBeNull();
      expect(report.sourceState).toBe('degraded');
      dirs.splice(0).forEach(dir => void rm(dir, { recursive: true, force: true }));
      vi.unstubAllEnvs();
    }
  });

  it('reports missing with no invented lastTick when status.json is absent but runs dir exists', async () => {
    await homeWithFiles({ '.ashlr-runs/queue/claimed.tsv': '' });
    const { report } = await lanesJson();
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('missing');
  });

  it('keeps the real lastTick and valid lanes while degrading on one malformed lane entry', async () => {
    await homeWithFiles(statusFile({ ...HEADER, lanes: {
      'good-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      'bad-lane': { running: 'many', target: 2, queued: 0, held: false },
      'bad-held': { running: 0, target: 1, queued: 0, held: 'yes' },
    } }));
    const { report } = await lanesJson();
    expect(report.sourceState).toBe('degraded');
    expect(report.lastTick).toBe('2026-11-13T15:00:00Z');
    const names = report.lanes.map((l: { lane: string }) => l.lane);
    expect(names).toEqual(['good-lane']);
  });
});
