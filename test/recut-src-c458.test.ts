/**
 * Recut regression for RQ-PHX-RECUTSRCC458 (SRC bucket), landing the stranded
 * #6054 lane-observation suite. Exercises the real `readFleetRunsDirState`
 * projection end to end against a temporary runs dir: measured lanes keep their
 * figures, auxiliary sources (claimed.tsv, switches, claude-lane, drop,
 * jobs.jsonl metrics) join independently, and malformed rows degrade only
 * their own source.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const dirs: string[] = [];
const NOW = Date.parse('2026-11-16T12:00:00Z');

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function runsDirWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recut-src-c458-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  return root;
}

const HEADER = {
  last_tick: '2026-11-16T11:59:00Z',
  paused: 'operator hold for maintenance',
  mem_free_pct: 62,
  schema: 'dispatchd.status.v1',
};

describe('readFleetRunsDirState combined sources (recut SRC C458)', () => {
  it('joins lanes, claimed rows, switches, claude lane, drop and hourly metrics', async () => {
    const runsDir = await runsDirWith({
      'queue/status.json': JSON.stringify({
        ...HEADER,
        autopilot: { disk: { free_gb: 412.5 } },
        rollup_24h: { by_lane: { 'lane-a': { merged: 7, merge_rate: 0.25 } } },
        lanes: {
          'lane-a': { running: 2, target: 4, queued: 1, floor: null, ceiling: 6, held: false, healthy: true },
          'lane-b': { running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: true, held_reason: 'quota hold /Users/someone/private/path' },
        },
      }),
      'queue/claimed.tsv': 'JOB-1\tlane-a\twork\t11:30\t1763286600\nJOB-BAD\tlane a\twork\t11:30\t1763286600\n',
      'dispatch-events.log': '2026-11-16 11:58:00 LAUNCH job=JOB-1 lane=lane-a\n2026-11-16 11:59:00 PUBLISHED pr=123\nnot-a-log-line\n',
      'metrics/jobs.jsonl': [
        JSON.stringify({ job: 'JOB-1', lane: 'lane-a', event: 'finish', tokens_total: 12345, ts: '2026-11-16T11:30:00Z' }),
        JSON.stringify({ job: 'JOB-1', lane: 'lane-a', event: 'publish', class: 'pr', url: 'https://github.com/ashlrai/phantom/pull/1', ts: '2026-11-16T11:31:00Z' }),
        'not json',
      ].join('\n'),
      'queue/claude-lane.state': 'claude\n',
      'HOLD': '',
      'leader/drop/lane-a/note-1.md': '# drop note\n',
      'leader/drop/done/old.md': '# done\n',
    });
    const state = await readFleetRunsDirState({ runsDir, now: () => NOW });
    expect(state.runsDirPresent).toBe(true);
    expect(state.paused).toBe(true);
    expect(state.memFreePct).toBe(62);
    expect(state.diskFreeGb).toBe(412.5);
    const lanes = Object.fromEntries(state.lanes.map(l => [l.lane, l]));
    expect(lanes['lane-a']).toMatchObject({
      running: 2, target: 4, queued: 1, floor: null, ceiling: 6,
      held: false, healthy: true, merged24h: 7, mergeRate24h: 0.25, tokensLastHour: 12345,
    });
    expect(lanes['lane-b']!.heldReason).toBe('quota hold [path]');
    expect(state.sources.metrics).toBe('degraded'); // one corrupt line degrades only metrics
    expect(state.sources.claimed).toBe('degraded'); // the lane-with-space row is rejected
    expect(state.claimed).toEqual([{ job: 'JOB-1', lane: 'lane-a', tier: 'work', at: new Date(1763286600 * 1000).toISOString() }]);
    expect(state.switches).toEqual(['HOLD']);
    expect(state.claudeLane).toBe('claude');
    expect(state.drop.pending).toEqual([{ lane: 'lane-a', file: 'note-1.md' }]);
    expect(state.drop.done).toBe(1);
    expect(state.publishesLastHour).toEqual([
      { job: 'JOB-1', lane: 'lane-a', url: 'https://github.com/ashlrai/phantom/pull/1', at: '2026-11-16T11:31:00Z' },
    ]);
    expect(state.events.map(e => e.kind)).toEqual(['PUBLISHED', 'LAUNCH']);
    expect(state.sourceState).toBe('degraded');
  });

  it('keeps lanes and lastTick when only the metrics file is absent', async () => {
    const runsDir = await runsDirWith({
      'queue/status.json': JSON.stringify({ ...HEADER, lanes: {
        'solo-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      } }),
      'queue/claimed.tsv': '',
      'leader/drop/done/.keep': '',
    });
    const state = await readFleetRunsDirState({ runsDir, now: () => NOW });
    expect(state.sources.metrics).toBe('missing');
    expect(state.sources.claimed).toBe('healthy');
    expect(state.lastTick).toBe(HEADER.last_tick);
    expect(state.lanes).toHaveLength(1);
    expect(state.lanes[0]!.tokensLastHour).toBeNull();
  });
});
