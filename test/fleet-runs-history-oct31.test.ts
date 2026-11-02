/**
 * fleet/runs-history.ts — the durable JSONL lane series behind
 * GET /api/verse/runs-history. Temp files only; fixture values are fake.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRunsSample,
  collectRunsSample,
  readRunsHistory,
  runsHistoryFile,
  RUNS_HISTORY_MAX_BYTES,
  sampleIfDue,
  type RunsSample,
} from '../src/core/fleet/runs-history.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const AT = '2026-10-31T12:00:00.000Z';
const NOW = Date.parse(AT);

const sample = (at: string, running = 1): RunsSample => ({
  at,
  lanes: [{ lane: 'fake-lane', running, target: 2, queued: 3, held: false }],
  workers: 4,
  leaders: 1,
  paused: false,
});

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runs-history-'));
  file = join(dir, 'fleet', 'runs-history.jsonl');
  // appendRunsSample mkdirs on its own; tests that seed the file directly need it first.
  await mkdir(join(dir, 'fleet'), { recursive: true });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const lines = async () => (await readFile(file, 'utf8')).split('\n').filter(Boolean);

describe('appendRunsSample + readRunsHistory', () => {
  it('round-trips samples through a temp file', async () => {
    await appendRunsSample(sample(AT, 1), { file, now: () => NOW });
    await appendRunsSample(sample(AT, 2), { file, now: () => NOW });
    const history = await readRunsHistory({ file, now: () => NOW });
    expect(history).toMatchObject({ v: 1, sourceState: 'healthy', dropped: 0, from: expect.any(String), to: AT });
    expect(history.samples).toEqual([sample(AT, 1), sample(AT, 2)]);
  });

  it('reports a missing file instead of failing', async () => {
    const history = await readRunsHistory({ file: join(dir, 'absent.jsonl'), now: () => NOW });
    expect(history).toMatchObject({ sourceState: 'missing', dropped: 0, samples: [] });
  });

  it('keeps only the requested window and clamps hours to 1..168', async () => {
    await writeFile(file, `${JSON.stringify(sample('2026-10-29T00:00:00.000Z'))}\n${JSON.stringify(sample(AT))}\n`, 'utf8');
    const day = await readRunsHistory({ file, hours: 24, now: () => NOW });
    expect(day.samples).toEqual([sample(AT)]);
    const threeDays = await readRunsHistory({ file, hours: 72, now: () => NOW });
    expect(threeDays.samples).toHaveLength(2);
    const clampedLow = await readRunsHistory({ file, hours: 0, now: () => NOW });
    expect(Date.parse(clampedLow.from)).toBe(NOW - 3_600_000);
    const clampedHigh = await readRunsHistory({ file, hours: 999, now: () => NOW });
    expect(Date.parse(clampedHigh.from)).toBe(NOW - 168 * 3_600_000);
  });

  it('skips malformed lines and counts them in dropped', async () => {
    await writeFile(file, [
      JSON.stringify(sample(AT)),
      'not-json{',
      JSON.stringify({ wrong: 1 }),
      JSON.stringify({ ...sample(AT), workers: 'many' }),
      JSON.stringify(sample('2026-10-31T11:00:00.000Z', 5)),
    ].join('\n') + '\n', 'utf8');
    const history = await readRunsHistory({ file, now: () => NOW });
    expect(history.samples).toEqual([sample(AT), sample('2026-10-31T11:00:00.000Z', 5)]);
    expect(history.dropped).toBe(3);
    expect(history.sourceState).toBe('degraded');
  });

  it('leaves sub-2MiB files alone, then compacts past 2MiB keeping only <7d lines', async () => {
    const fresh = JSON.stringify(sample(AT));
    const old = JSON.stringify({ ...sample('2026-10-23T00:00:00.000Z'), lanes: [{ lane: 'fake-old-lane', running: 9, target: 9, queued: 9, held: true }] });
    // Small file: an old line is appended next to fresh ones and survives —
    // it is filtered on READ, not rewritten.
    await writeFile(file, `${old}\n${fresh}\n`, 'utf8');
    await appendRunsSample(sample(AT), { file, now: () => NOW });
    expect(await readFile(file, 'utf8')).toContain('fake-old-lane');

    // Oversized file of mostly >7d lines: appending triggers the rewrite;
    // stale lines are physically dropped, the fresh line and the new sample stay.
    const stale = JSON.stringify({ ...sample('2026-10-23T00:00:00.000Z'), lanes: [{ lane: 'fake-stale-lane', running: 8, target: 8, queued: 8, held: false }] });
    const filler = `${stale}\n`.repeat(Math.ceil(RUNS_HISTORY_MAX_BYTES / (stale.length + 1)) + 64);
    await writeFile(file, `${fresh}\n${filler}`, 'utf8');
    expect((await stat(file)).size).toBeGreaterThan(RUNS_HISTORY_MAX_BYTES);
    await appendRunsSample(sample(AT), { file, now: () => NOW });
    const compacted = await readFile(file, 'utf8');
    expect(compacted).not.toContain('fake-stale-lane');
    expect(compacted).toContain('fake-lane');
    expect((await stat(file)).size).toBeLessThan(4096);
    const history = await readRunsHistory({ file, now: () => NOW });
    expect(history.sourceState).toBe('healthy');
    expect(history.dropped).toBe(0);
    expect(history.samples.every((s) => Date.parse(s.at) >= NOW - 24 * 3_600_000)).toBe(true);
    expect(history.samples).toHaveLength(2);
  });
});

describe('sampleIfDue', () => {
  it('samples at t=0, not at t=30s, again at t=61s (fake clock)', async () => {
    let t = NOW;
    const now = () => t;
    const read = async (clock: () => number) => sample(new Date(clock()).toISOString());
    const opts = { file, now, read };
    expect(await sampleIfDue(opts)).toBe(true);
    t += 30_000;
    expect(await sampleIfDue(opts)).toBe(false);
    t += 31_000;
    expect(await sampleIfDue(opts)).toBe(true);
    expect(await lines()).toHaveLength(2);
    expect(JSON.parse((await lines()).pop()!).at).toBe(new Date(NOW + 61_000).toISOString());
  });

  it('samples again when the file is absent or its last line is corrupt', async () => {
    const read = async (clock: () => number) => sample(new Date(clock()).toISOString());
    expect(await sampleIfDue({ file, now: () => NOW, read })).toBe(true);
    await appendFile(file, 'garbage\n', 'utf8');
    expect(await sampleIfDue({ file, now: () => NOW + 1, read })).toBe(true);
  });
});

describe('collectRunsSample', () => {
  const dirState = (over: Partial<FleetRunsDirState> = {}): FleetRunsDirState => ({
    v: 1, generatedAt: AT, runsDirPresent: true, sourceState: 'healthy',
    sources: { status: 'healthy', claimed: 'missing', events: 'missing', metrics: 'missing', claudeLane: 'missing', switches: 'missing', drop: 'missing' },
    lastTick: AT, paused: false, memFreePct: 50, diskFreeGb: 100,
    lanes: [{ lane: 'fake-lane', running: 1, target: 2, queued: 3, held: true, floor: null, ceiling: null, heldReason: 'fixture reason', tokensLastHour: 7, merged24h: 5, mergeRate24h: 0.5 }],
    switches: ['PAUSE'], claudeLane: 'fake-lane', publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
    ...over,
  });
  const liveSnap = (over: Partial<LiveWorkersSnapshot> = {}): LiveWorkersSnapshot => ({
    v: 1, generatedAt: AT, sourceState: 'healthy',
    workers: [{ pid: 1, job: 'fake-job', repo: 'fake', lane: 'fake-lane', tier: 'work', ageSeconds: 10 }],
    leaders: [{ pid: 2, label: 'fake-leader', ageSeconds: null }, { pid: 3, label: 'fake-leader-2', ageSeconds: 5 }],
    orchestratorAgents: 0,
    ...over,
  });

  it('composes lane counts and process counts into one sample', async () => {
    const s = await collectRunsSample({ now: () => NOW, readRunsDir: async () => dirState(), listWorkers: async () => liveSnap() });
    expect(s).toEqual({
      at: AT,
      lanes: [{ lane: 'fake-lane', running: 1, target: 2, queued: 3, held: true }],
      workers: 1,
      leaders: 2,
      paused: false,
    });
  });

  it('keeps worker/leader counts when the runs-dir read throws, with lanes empty', async () => {
    const s = await collectRunsSample({
      now: () => NOW,
      readRunsDir: async () => { throw new Error('boom'); },
      listWorkers: async () => liveSnap(),
    });
    expect(s.lanes).toEqual([]);
    expect(s.paused).toBeNull();
    expect(s.workers).toBe(1);
    expect(s.leaders).toBe(2);
  });

  it('reports null counts — never a dishonest 0 — when the process read fails or is unavailable', async () => {
    const throwing = await collectRunsSample({
      now: () => NOW,
      readRunsDir: async () => dirState(),
      listWorkers: async () => { throw new Error('ps failed'); },
    });
    expect(throwing.workers).toBeNull();
    expect(throwing.leaders).toBeNull();
    expect(throwing.lanes).toHaveLength(1);
    const unavailable = await collectRunsSample({
      now: () => NOW,
      readRunsDir: async () => dirState(),
      listWorkers: async () => liveSnap({ sourceState: 'unavailable', workers: [], leaders: [] }),
    });
    expect(unavailable.workers).toBeNull();
    expect(unavailable.leaders).toBeNull();
  });
});

describe('runsHistoryFile', () => {
  it('honors an absolute ASHLR_RUNS_HISTORY_FILE and ignores a relative one', () => {
    vi.stubEnv('ASHLR_HOME', join(dir, 'state'));
    expect(runsHistoryFile()).toBe(join(dir, 'state', 'fleet', 'runs-history.jsonl'));
    vi.stubEnv('ASHLR_RUNS_HISTORY_FILE', join(dir, 'custom.jsonl'));
    expect(runsHistoryFile()).toBe(join(dir, 'custom.jsonl'));
    vi.stubEnv('ASHLR_RUNS_HISTORY_FILE', 'relative/path.jsonl');
    expect(runsHistoryFile()).toBe(join(dir, 'state', 'fleet', 'runs-history.jsonl'));
  });
});
