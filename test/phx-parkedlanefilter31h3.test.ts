import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';

let dir: string;
let output: string[];
let errors: string[];
const now = Date.parse('2026-10-31T12:00:00Z');
const deps = {
  runs: () => readFleetRunsDirState({ runsDir: dir, now: () => now }),
  parked: () => readFleetQueue({ runsDir: dir, now: () => now }),
  journal: () => readLeaderJournal({ runsDir: dir, now: () => now }),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phm-lane-filter-'));
  await mkdir(join(dir, 'queue'));
  await mkdir(join(dir, 'metrics'));
  await mkdir(join(dir, 'leader/drop/codex-personal'), { recursive: true });
  await mkdir(join(dir, 'leader/drop/devin'));
  await mkdir(join(dir, 'leader/drop/done'));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
    last_tick: '2026-10-31T11:59:00Z', paused: false, mem_free_pct: 50,
    lanes: {
      'codex-personal': { running: 0, target: 2, queued: 1, held: true, held_reason: 'manual hold' },
      devin: { running: 1, target: 2, queued: 1, held: false },
    },
  }));
  await writeFile(join(dir, 'queue/ready.tsv'), 'status\tid\tlane\nPARKED-HOLD.codex-personal\tJOB-PERSONAL\tcodex-personal\nREADY\tJOB-DEVIN\tdevin\n');
  const recent = new Date(now - 3_600_000);
  const localTime = `${recent.getFullYear()}-${String(recent.getMonth() + 1).padStart(2, '0')}-${String(recent.getDate()).padStart(2, '0')} ${String(recent.getHours()).padStart(2, '0')}:${String(recent.getMinutes()).padStart(2, '0')}:${String(recent.getSeconds()).padStart(2, '0')}`;
  await writeFile(join(dir, 'queue/precheck-skips.tsv'), `${localTime}\tJOB-DEVIN\tSKIP\tbusy\n`);
  await writeFile(join(dir, 'queue/claimed.tsv'), 'JOB-PERSONAL\tcodex-personal\tT1\t11:00\t1793444400\nJOB-DEVIN\tdevin\tT1\t11:00\t1793444400\n');
  await writeFile(join(dir, 'metrics/jobs.jsonl'), [
    { job: 'JOB-PERSONAL', lane: 'codex-personal', ts: '2026-10-31T11:30:00Z', event: 'publish', class: 'pr' },
    { job: 'JOB-DEVIN', lane: 'devin', ts: '2026-10-31T11:30:00Z', event: 'publish', class: 'pr' },
    { job: 'JOB-UNKNOWN', ts: '2026-10-31T11:30:00Z', event: 'publish', class: 'pr' },
  ].map(row => JSON.stringify(row)).join('\n'));
  await writeFile(join(dir, 'dispatch-events.log'), '2026-10-31 11:00:00 LAUNCH JOB-DEVIN\n');
  await writeFile(join(dir, 'leader/drop/codex-personal/ONE.md'), 'fake');
  await writeFile(join(dir, 'leader/drop/devin/TWO.md'), 'fake');
  await writeFile(join(dir, 'leader/drop/done/DONE.md'), 'fake');
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((message) => { errors.push(String(message)); return true; });
});

afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

async function json(verb: 'runs' | 'parked', args: string[] = []) {
  output.length = 0;
  expect(await cmdFleetRunsRead(verb, ['--json', ...args], deps)).toBe(0);
  return JSON.parse(output[0]!);
}

describe('fleet lane-filtered reads', () => {
  it('filters lane rows for a held personal lane and an available Devin lane while keeping global values', async () => {
    const allRuns = await json('runs');
    const allParked = await json('parked');
    expect(allRuns.lanes.map((row: { lane: string }) => row.lane)).toEqual(['codex-personal', 'devin']);
    expect(allParked).toMatchObject({ total: 2, ready: 1, parked: 1, skipsLast24h: 1 });
    expect(allParked.skips).toHaveLength(1);

    const personal = await json('runs', ['--lane', 'codex-personal']);
    expect(personal.lanes).toMatchObject([{ lane: 'codex-personal', held: true, heldReason: 'manual hold' }]);
    expect(personal.claimed.map((row: { job: string }) => row.job)).toEqual(['JOB-PERSONAL']);
    expect(personal.publishesLastHour.map((row: { job: string }) => row.job)).toEqual(['JOB-PERSONAL']);
    expect(personal.drop).toEqual({ pending: [{ lane: 'codex-personal', file: 'ONE.md' }], done: 1 });
    expect(personal.events).toEqual([]);
    expect(personal.sources).toEqual(allRuns.sources);
    expect(personal.sourceState).toEqual(allRuns.sourceState);
    expect(personal.laneFilter).toMatchObject({ lane: 'codex-personal', omitted: ['events'] });
    expect(personal.laneFilter.global).toContain('drop.done');

    const personalQueue = await json('parked', ['--lane', 'codex-personal']);
    expect(personalQueue.byLane).toEqual([{ lane: 'codex-personal', ready: 0, parked: 1 }]);
    expect(personalQueue.groups).toMatchObject([{ lane: 'codex-personal', jobs: ['JOB-PERSONAL'] }]);
    expect(personalQueue).toMatchObject({ total: 2, ready: 1, parked: 1, skipsLast24h: 1, skips: [], sources: allParked.sources });
    expect(personalQueue.laneFilter.global).toContain('total');
    expect(personalQueue.laneFilter.omitted).toEqual(['skips']);

    const devin = await json('runs', ['--lane', 'devin']);
    expect(devin.lanes).toMatchObject([{ lane: 'devin', held: false }]);
    expect(devin.claimed.map((row: { job: string }) => row.job)).toEqual(['JOB-DEVIN']);
    const devinQueue = await json('parked', ['--lane', 'devin']);
    expect(devinQueue.byLane).toEqual([{ lane: 'devin', ready: 1, parked: 0 }]);
    expect(devinQueue.groups).toEqual([]);
    expect(devinQueue.total).toBe(2);
  });

  it('returns empty lane rows for an absent lane and labels global values in text', async () => {
    const runs = await json('runs', ['--lane', 'claude']);
    expect(runs).toMatchObject({ lanes: [], claimed: [], publishesLastHour: [], events: [], drop: { pending: [], done: 1 } });
    const parked = await json('parked', ['--lane', 'claude']);
    expect(parked).toMatchObject({ byLane: [], groups: [], skips: [], total: 2, ready: 1, parked: 1 });
    output.length = 0;
    expect(await cmdFleetRunsRead('parked', ['--lane', 'claude'], deps)).toBe(0);
    expect(output[0]).toContain('totals and source health are global');
    expect(output[0]).toContain('Total: 2; ready: 1; parked: 1');
    expect(output[0]).not.toContain('JOB-DEVIN');
    output.length = 0;
    expect(await cmdFleetRunsRead('runs', ['--lane', 'codex-personal'], deps)).toBe(0);
    expect(output[0]).toContain('codex-personal: 0/2 running');
    expect(output[0]).not.toContain('devin:');
    expect(output[0]).toContain('source health and other non-row values are global');
  });

  it('preserves default JSON and text projections', async () => {
    expect(await json('runs')).toEqual(await deps.runs());
    expect(await json('parked')).toEqual(await deps.parked());
    output.length = 0;
    expect(await cmdFleetRunsRead('parked', [], deps)).toBe(0);
    expect(output[0]).toContain('devin: 1 ready, 0 parked');
    expect(output[0]).toContain('JOB-DEVIN');
  });

  it('documents scope and rejects missing, duplicate, malformed and journal lane arguments before reading', async () => {
    for (const verb of ['runs', 'parked'] as const) {
      output.length = 0;
      expect(await cmdFleetRunsRead(verb, ['--help'], deps)).toBe(0);
      expect(output[0]).toContain('--lane <lane>');
      expect(output[0]).toContain('totals and source health remain global');
      for (const args of [['--lane'], ['--lane', '--json'], ['--lane', 'a', '--lane', 'b'], ['--lane', '../bad'], ['--lane', '']]) {
        const unread = { ...deps, [verb]: vi.fn(() => { throw new Error('unexpected read'); }) };
        expect(await cmdFleetRunsRead(verb, args, unread)).toBe(2);
        expect(unread[verb]).not.toHaveBeenCalled();
      }
    }
    const journal = vi.fn(deps.journal);
    expect(await cmdFleetRunsRead('journal', ['--lane', 'devin'], { ...deps, journal })).toBe(2);
    expect(journal).not.toHaveBeenCalled();
    expect(errors.join('')).toContain('invalid fleet journal arguments');
  });

  it('retains degraded source health and refuses symlinked queue data', async () => {
    await rm(join(dir, 'queue/ready.tsv'));
    await symlink(join(dir, 'queue/status.json'), join(dir, 'queue/ready.tsv'));
    const parked = await json('parked', ['--lane', 'devin']);
    expect(parked).toMatchObject({ sources: { ready: 'degraded' }, byLane: [], total: 0 });
    expect(await cmdFleetRunsRead('runs', ['--lane', 'devin'], { ...deps, runs: async () => { throw new Error('private detail'); } })).toBe(1);
    expect(errors.join('')).toContain('fleet runs unavailable');
    expect(errors.join('')).not.toContain('private detail');
  });
});
