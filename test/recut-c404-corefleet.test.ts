import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function runsDirWithStatus(status: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recut-c404-'));
  dirs.push(root);
  await mkdir(join(root, 'queue'), { recursive: true });
  await writeFile(
    join(root, 'queue', 'status.json'),
    typeof status === 'string' ? status : JSON.stringify(status),
  );
  return root;
}

const baseStatus = {
  last_tick: '2026-11-11T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {},
};

describe('readFleetRunsDirState lane observation (recut of PR #5149)', () => {
  it('keeps measured healthy only when boolean and scrubs held_reason paths', async () => {
    const runsDir = await runsDirWithStatus({
      ...baseStatus,
      operator_secret: 'PRIVATE-MARKER-c404',
      lanes: {
        'alpha-lane': {
          running: 0, target: 1, queued: 0, held: true,
          held_reason: 'hold until /Users/someone/private/quota resets',
          api_token: 'PRIVATE-MARKER-c404',
          healthy: 'yes',
        },
        'beta-lane': { running: 1, target: 2, queued: 0, held: false, healthy: true },
      },
    });
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('healthy');
    const lanes = Object.fromEntries(state.lanes.map(l => [l.lane, l]));
    expect(lanes['beta-lane']!.healthy).toBe(true);
    expect('healthy' in lanes['alpha-lane']!).toBe(false);
    const text = JSON.stringify(state);
    expect(text).not.toContain('PRIVATE-MARKER-c404');
    expect(lanes['alpha-lane']!.heldReason).not.toContain('/Users/someone');
    expect(lanes['alpha-lane']!.heldReason).toContain('[path]');
  });

  it('reports a missing runs directory honestly', async () => {
    const state = await readFleetRunsDirState({ runsDir: join(tmpdir(), 'recut-c404-no-such-dir') });
    expect(state.runsDirPresent).toBe(false);
    expect(state.sourceState).toBe('missing');
    expect(state.sources.status).toBe('missing');
    expect(state.lanes).toEqual([]);
    expect(state.lastTick).toBeNull();
  });

  it('marks malformed status.json as degraded without inventing lanes', async () => {
    const runsDir = await runsDirWithStatus('{not json');
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('degraded');
    expect(state.lanes).toEqual([]);
    expect(state.lastTick).toBeNull();
  });
});
