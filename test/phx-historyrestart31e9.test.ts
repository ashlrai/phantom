import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunsSample } from '../src/core/fleet/runs-history.js';

const start = Date.parse('2026-10-30T23:45:00.000Z');
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
  root = await mkdtemp(join(tmpdir(), 'fake-history-restart-'));
  file = join(root, 'fleet', 'history.jsonl');
});
afterEach(async () => {
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

describe('fleet history across restarts', () => {
  it('preserves valid samples and reports an interrupted tail while resuming only when due', async () => {
    const first = await import('../src/core/fleet/runs-history.js');
    const before = [sample(start, 1), sample(start + 60_000, 2)];
    for (const row of before) await first.appendRunsSample(row, { file, now: () => start + 60_000 });
    await appendFile(file, '{"at":"fake-interrupted-shutdown', 'utf8');

    vi.resetModules();
    const restarted = await import('../src/core/fleet/runs-history.js');
    const later = start + 3 * 3_600_000;
    const readSample = vi.fn(async (clock: () => number) => sample(clock(), 3));
    expect(await restarted.readRunsHistory({ file, now: () => later })).toMatchObject({
      sourceState: 'degraded', dropped: 1, samples: before,
    });
    expect(await restarted.sampleIfDue({ file, now: () => later, read: readSample })).toBe(true);
    expect(readSample).toHaveBeenCalledTimes(1);
    expect(await restarted.readRunsHistory({ file, now: () => later })).toMatchObject({
      sourceState: 'degraded', dropped: 1, samples: [...before, sample(later, 3)],
    });

    vi.resetModules();
    const fresh = await import('../src/core/fleet/runs-history.js');
    expect(await fresh.sampleIfDue({ file, now: () => later + 30_000, read: readSample })).toBe(false);
    expect(readSample).toHaveBeenCalledTimes(1);
    expect(await fresh.sampleIfDue({ file, now: () => later + 60_000, read: readSample })).toBe(true);
    expect(await fresh.readRunsHistory({ file, now: () => later + 60_000 })).toMatchObject({
      sourceState: 'degraded', dropped: 1,
      samples: [...before, sample(later, 3), sample(later + 60_000, 3)],
    });
  });

  it('preserves a complete final sample that lacks a newline', async () => {
    const history = await import('../src/core/fleet/runs-history.js');
    await history.appendRunsSample(sample(start, 1), { file, now: () => start });
    const complete = (await readFile(file, 'utf8')).trimEnd();
    await writeFile(file, complete, 'utf8');
    await history.appendRunsSample(sample(start + 60_000, 2), { file, now: () => start + 60_000 });
    expect(await history.readRunsHistory({ file, now: () => start + 60_000 })).toMatchObject({
      sourceState: 'healthy', dropped: 0, samples: [sample(start, 1), sample(start + 60_000, 2)],
    });
  });
});
