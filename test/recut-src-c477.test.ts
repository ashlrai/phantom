/**
 * Recut regression for RQ-PHX-RECUTSRCC477 (SRC bucket), landing the stranded
 * #6273 lane-observation suite on current master. Exercises the real
 * `readFleetRunsDirState` projection against a temporary runs dir for the
 * surfaces the ported files do not cover: autopilot disk free and the 24h
 * rollup attach measured values per lane, the dispatch-events tail keeps only
 * allowlisted kinds with cleaned text in newest-first order, one malformed
 * claimed.tsv row degrades that source while the rest still parse, and the
 * drop directory counts done/ receipts separately from pending lanes.
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
  const root = await mkdtemp(join(tmpdir(), 'recut-src-c477-'));
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
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
};

const laneA = { running: 1, target: 2, queued: 0, floor: null, ceiling: 4, held: false, healthy: true };

describe('readFleetRunsDirState measured rollups (recut SRC C477)', () => {
  it('attaches autopilot disk free and per-lane 24h rollup figures as measurements', async () => {
    const runsDir = await runsDirWith({
      'queue/status.json': JSON.stringify({
        ...HEADER,
        autopilot: { disk: { free_gb: 128.5 } },
        rollup_24h: { by_lane: { 'lane-a': { merged: 7, merge_rate: 0.35 } } },
        lanes: { 'lane-a': laneA, 'lane-b': { ...laneA, running: 0, target: 1 } },
      }),
      'metrics/jobs.jsonl': '',
    });
    const state = await readFleetRunsDirState({ runsDir, now: () => NOW });
    expect(state.sources.status).toBe('healthy');
    expect(state.diskFreeGb).toBe(128.5);
    const a = state.lanes.find(l => l.lane === 'lane-a')!;
    expect(a.merged24h).toBe(7);
    expect(a.mergeRate24h).toBe(0.35);
    // No rollup row for lane-b: the figures stay null rather than inventing zero.
    const b = state.lanes.find(l => l.lane === 'lane-b')!;
    expect(b.merged24h).toBeNull();
    expect(b.mergeRate24h).toBeNull();
    // A readable-but-empty metrics file is a healthy source; lanes show measured zero.
    expect(state.sources.metrics).toBe('healthy');
    expect(a.tokensLastHour).toBe(0);
  });

  it('keeps allowlisted dispatch events newest-first and cleans path text', async () => {
    const runsDir = await runsDirWith({
      'queue/status.json': JSON.stringify({ ...HEADER, lanes: { 'lane-a': laneA } }),
      'dispatch-events.log': [
        '2026-11-16 11:50:00 LAUNCH lane-a job JOB-1 from /Users/ops/secrets/start.sh',
        '2026-11-16 11:51:00 GOSSIP ignored-kind must never surface',
        '2026-11-16 11:52:00 PUBLISHED JOB-1 https://github.com/ashlrai/phantom/pull/44',
      ].join('\n') + '\n',
    });
    const state = await readFleetRunsDirState({ runsDir, now: () => NOW });
    expect(state.sources.events).toBe('healthy');
    expect(state.events.map(e => e.kind)).toEqual(['PUBLISHED', 'LAUNCH']);
    expect(state.events[1]!.text).not.toContain('/Users/ops');
    expect(state.events[1]!.text).toContain('[path]');
  });

  it('degrades only claimed.tsv on a malformed row and accounts drop done vs pending', async () => {
    const runsDir = await runsDirWith({
      'queue/status.json': JSON.stringify({ ...HEADER, lanes: { 'lane-a': laneA } }),
      'queue/claimed.tsv': [
        'JOB-7\tlane-a\twork\t11:58\t1794441600',
        'garbage row without tabs',
      ].join('\n') + '\n',
      'leader/drop/lane-a/note-1.md': '# note\n',
      'leader/drop/lane-a/note-2.md': '# note\n',
      'leader/drop/done/2026-11-16-lane-a.md': '# done\n',
      'leader/drop/done/2026-11-15-lane-b.md': '# done\n',
    });
    const state = await readFleetRunsDirState({ runsDir, now: () => NOW });
    expect(state.sources.claimed).toBe('degraded');
    expect(state.claimed).toEqual([
      { job: 'JOB-7', lane: 'lane-a', tier: 'work', at: '2026-11-12T00:00:00.000Z' },
    ]);
    expect(state.sources.drop).toBe('healthy');
    expect(state.drop.pending).toEqual([
      { lane: 'lane-a', file: 'note-1.md' },
      { lane: 'lane-a', file: 'note-2.md' },
    ]);
    expect(state.drop.done).toBe(2);
  });
});
