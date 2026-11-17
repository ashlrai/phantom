import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function runsDirWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recut-c413-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  return root;
}

const statusFile = (status: unknown) => ({
  'queue/status.json': typeof status === 'string' ? status : JSON.stringify(status),
});

const HEADER = {
  last_tick: '2026-11-13T15:00:00Z',
  paused: null,
  mem_free_pct: 40,
  schema: 'dispatchd.status.v1',
};

describe('readFleetRunsDirState owner-proof lane observation (recut of #5398)', () => {
  it('keeps measured zeros as zero and null bounds as null', async () => {
    const runsDir = await runsDirWith(statusFile({ ...HEADER, lanes: {
      'zero-lane': { running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true },
      'null-bounds': { running: 1, target: 3, queued: 2, floor: null, ceiling: null, held: false },
    } }));
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('healthy');
    expect(state.lastTick).toBe('2026-11-13T15:00:00Z');
    const lanes = Object.fromEntries(state.lanes.map(l => [l.lane, l]));
    expect(lanes['zero-lane']).toMatchObject({ running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true });
    expect(lanes['null-bounds']).toMatchObject({ running: 1, target: 3, queued: 2, floor: null, ceiling: null });
    expect(lanes['null-bounds']!.healthy).toBeUndefined();
  });

  it('passes measured 24h rollup figures through verbatim per lane', async () => {
    const runsDir = await runsDirWith(statusFile({ ...HEADER,
      rollup_24h: { by_lane: {
        'measured-lane': { merged: 4, merge_rate: 0.5 },
        'sparse-lane': { merged: 0 },
      } },
      lanes: {
        'measured-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
        'sparse-lane': { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: false },
        'unrolled-lane': { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: false },
      } }));
    const state = await readFleetRunsDirState({ runsDir });
    const lanes = Object.fromEntries(state.lanes.map(l => [l.lane, l]));
    expect(lanes['measured-lane']).toMatchObject({ merged24h: 4, mergeRate24h: 0.5 });
    expect(lanes['sparse-lane']!.merged24h).toBe(0);
    // A lane with no rollup entry stays unmeasured (null), never an invented zero.
    expect(lanes['unrolled-lane']).toMatchObject({ merged24h: null, mergeRate24h: null });
  });

  it('distinguishes unmeasured usage (null) from a measured zero', async () => {
    // metrics/jobs.jsonl absent -> tokensLastHour is unknown (null).
    const noMetrics = await runsDirWith(statusFile({ ...HEADER, lanes: {
      'lane-a': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
    } }));
    const unknown = await readFleetRunsDirState({ runsDir: noMetrics });
    expect(unknown.sources.metrics).toBe('missing');
    expect(unknown.lanes[0]!.tokensLastHour).toBeNull();
    // metrics/jobs.jsonl present but empty -> a measured zero, not null.
    const emptyMetrics = await runsDirWith({
      ...statusFile({ ...HEADER, lanes: {
        'lane-a': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      } }),
      'metrics/jobs.jsonl': '',
    });
    const measured = await readFleetRunsDirState({ runsDir: emptyMetrics });
    expect(measured.sources.metrics).toBe('healthy');
    expect(measured.lanes[0]!.tokensLastHour).toBe(0);
  });

  it('keeps real lastTick and valid lanes while degrading on one malformed lane entry', async () => {
    const runsDir = await runsDirWith(statusFile({ ...HEADER, lanes: {
      'good-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      'bad-lane': { running: 'many', target: 2, queued: 0, held: false },
      'bad-held': { running: 0, target: 1, queued: 0, held: 'yes' },
    } }));
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('degraded');
    expect(state.lastTick).toBe('2026-11-13T15:00:00Z');
    expect(state.lanes.map(l => l.lane)).toEqual(['good-lane']);
  });

  it('reports missing status.json without inventing lastTick or lanes', async () => {
    const runsDir = await runsDirWith({ 'queue/claimed.tsv': '' });
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.runsDirPresent).toBe(true);
    expect(state.sources.status).toBe('missing');
    expect(state.lanes).toEqual([]);
    expect(state.lastTick).toBeNull();
  });

  it('never promotes non-boolean healthy and scrubs held_reason paths', async () => {
    const marker = ['PRIVATE', '-MARKER', '-c413'].join('');
    const secretKey = ['operator', '_secret'].join('');
    const tokenKey = ['api', '_token'].join('');
    const runsDir = await runsDirWith(statusFile({ ...HEADER,
      [secretKey]: marker,
      lanes: {
        'alpha-lane': {
          running: 0, target: 1, queued: 0, held: true,
          held_reason: 'hold until /Users/someone/private/quota resets',
          [tokenKey]: marker,
          healthy: 'yes',
        },
      } }));
    const state = await readFleetRunsDirState({ runsDir });
    const lane = state.lanes[0]!;
    expect('healthy' in lane).toBe(false);
    expect(lane.heldReason).not.toContain('/Users/someone');
    expect(lane.heldReason).toContain('[path]');
    expect(JSON.stringify(state)).not.toContain(marker);
  });
});
