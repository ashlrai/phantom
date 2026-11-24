/**
 * Recut regression for RQ-PHX-RECUTSRCC465 (SRC bucket), landing the stranded
 * #6231 lane-observation suite on current master. Exercises the real
 * `readFleetRunsDirState` projection against a temporary runs dir for the
 * boundary cases the ported files do not cover: a clipped metrics tail keeps
 * hourly token totals unknown while still listing individual publishes, the
 * dispatcher's own pause shape maps honestly and unknown producers degrade
 * rather than guess, global slot keys never become lanes, and an absent
 * drop/done directory reports that source missing on its own.
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
  const root = await mkdtemp(join(tmpdir(), 'recut-src-c465-'));
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
  mem_free_pct: 41,
  schema: 'dispatchd.status.v1',
};

const laneA = { running: 1, target: 2, queued: 0, floor: null, ceiling: 4, held: false };

describe('readFleetRunsDirState boundary honesty (recut SRC C465)', () => {
  it('keeps hourly token totals unknown when the metrics file is clipped, while still listing publishes', async () => {
    // A jobs.jsonl past the bounded tail proves individual publish rows but
    // cannot prove complete hourly totals: publishes list, totals stay null.
    const publish = JSON.stringify({ job: 'JOB-9', lane: 'lane-a', event: 'publish', class: 'pr', url: 'https://github.com/ashlrai/phantom/pull/9', ts: '2026-11-16T11:55:00Z' });
    const finish = JSON.stringify({ job: 'JOB-9', lane: 'lane-a', event: 'finish', tokens_total: 777, ts: '2026-11-16T11:55:00Z' });
    const filler = JSON.stringify({ job: 'JOB-9', event: 'note', ts: '2026-11-16T10:30:00Z', text: 'x'.repeat(180) }) + '\n';
    const body = filler.repeat(Math.ceil(1_100_000 / filler.length)) + publish + '\n' + finish + '\n';
    const runsDir = await runsDirWith({
      'queue/status.json': JSON.stringify({ ...HEADER, paused: 'operator hold', lanes: { 'lane-a': laneA } }),
      'metrics/jobs.jsonl': body,
    });
    const state = await readFleetRunsDirState({ runsDir, now: () => NOW });
    expect(state.sources.metrics).toBe('degraded');
    expect(state.publishesLastHour).toEqual([
      { job: 'JOB-9', lane: 'lane-a', url: 'https://github.com/ashlrai/phantom/pull/9', at: '2026-11-16T11:55:00Z' },
    ]);
    expect(state.lanes[0]!.tokensLastHour).toBeNull();
  });

  it('maps the dispatcher pause shape honestly and degrades on unknown producers', async () => {
    // The v1 producer writes paused as a reason string or explicit null; only
    // that known shape gives null the meaning "not paused".
    const known = await runsDirWith({
      'queue/status.json': JSON.stringify({ ...HEADER, paused: null, lanes: { 'lane-a': laneA } }),
    });
    const notPaused = await readFleetRunsDirState({ runsDir: known, now: () => NOW });
    expect(notPaused.paused).toBe(false);
    expect(notPaused.sources.status).toBe('healthy');

    // Without the producer schema a missing pause bit is unknowable; the whole
    // status source degrades instead of inventing a false.
    const unknown = await runsDirWith({
      'queue/status.json': JSON.stringify({ last_tick: HEADER.last_tick, mem_free_pct: 41, lanes: {} }),
    });
    const unstated = await readFleetRunsDirState({ runsDir: unknown, now: () => NOW });
    expect(unstated.paused).toBeNull();
    expect(unstated.lastTick).toBeNull();
    expect(unstated.sources.status).toBe('degraded');
  });

  it('never promotes global slot keys to lanes and reports drop missing when done/ is absent', async () => {
    const runsDir = await runsDirWith({
      'queue/status.json': JSON.stringify({ ...HEADER, paused: 'operator hold', lanes: {
        'lane-a': laneA,
        hard_cap: { running: 0, target: 99, queued: 0, floor: 0, ceiling: 99, held: false },
        last_change_by: 'operator one-off',
      } }),
      'leader/drop/lane-a/note-1.md': '# pending note\n',
    });
    const state = await readFleetRunsDirState({ runsDir, now: () => NOW });
    expect(state.lanes.map(l => l.lane)).toEqual(['lane-a']);
    expect(state.sources.status).toBe('healthy');
    // ENOENT on the required done/ directory reports the source missing;
    // pending rows already collected stay visible rather than vanishing.
    expect(state.sources.drop).toBe('missing');
    expect(state.drop.pending).toEqual([{ lane: 'lane-a', file: 'note-1.md' }]);
    expect(state.drop.done).toBe(0);
  });
});
