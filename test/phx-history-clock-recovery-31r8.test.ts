import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRunsSample,
  readRunsHistory,
  sampleIfDue,
  type RunsSample,
} from '../src/core/fleet/runs-history.js';

const nowMs = Date.parse('2026-10-30T23:49:00.000Z');
const hourMs = 3_600_000;
const sample = (time: number, running: number): RunsSample => ({
  at: new Date(time).toISOString(),
  lanes: [{ lane: 'fake-lane', running, target: 3, queued: 1, held: false }],
  workers: 2,
  leaders: 1,
  paused: false,
});

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fake-history-clock-'));
  file = join(root, 'history.jsonl');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('fleet history clock recovery', () => {
  it('includes both window bounds and excludes samples just outside them', async () => {
    const rows = [
      sample(nowMs - hourMs - 1, 1),
      sample(nowMs - hourMs, 2),
      sample(nowMs, 3),
      sample(nowMs + 1, 4),
    ];
    for (const row of rows) await appendRunsSample(row, { file, now: () => nowMs });

    const history = await readRunsHistory({ file, hours: 1, now: () => nowMs });
    expect(history).toMatchObject({
      from: rows[1].at, to: rows[2].at, sourceState: 'healthy', dropped: 0,
      samples: [rows[1], rows[2]],
    });
  });

  it('resumes sampling after a future last row without removing it or repeating at the same time', async () => {
    const past = sample(nowMs - 60_000, 1);
    const future = sample(nowMs + hourMs, 2);
    const current = sample(nowMs, 3);
    await appendRunsSample(past, { file, now: () => nowMs });
    await appendRunsSample(future, { file, now: () => nowMs });

    expect(await readRunsHistory({ file, now: () => nowMs })).toMatchObject({
      sourceState: 'healthy', dropped: 0, samples: [past],
    });
    const read = vi.fn(async (clock: () => number) => sample(clock(), 3));
    const opts = { file, now: () => nowMs, read };
    expect(await sampleIfDue(opts)).toBe(true);
    expect(await sampleIfDue(opts)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await readRunsHistory({ file, now: () => nowMs })).toMatchObject({
      sourceState: 'healthy', dropped: 0, samples: [past, current],
    });
    const onDisk = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(onDisk).toEqual([past, future, current]);
  });
});
