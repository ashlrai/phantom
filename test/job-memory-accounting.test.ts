import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobMemoryAccumulator, processTreeMemory, isMemoryJobRecord, appendMemoryJobRecord, startJobMemorySampling, type MemoryJobRecord } from '../src/core/memory/job-accounting.js';
import { computeMemoryImpact } from '../src/core/fleet/scorecard.js';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), appendFile: vi.fn(), readFile: vi.fn() }));
import { appendFile } from 'node:fs/promises';
const sample = (rssBytes: number, swapBytes: number | null = 0) => ({ pid: 1, ppid: 0, rssBytes, swapBytes });
function record(jobId = 'job'): MemoryJobRecord {
  const a = new JobMemoryAccumulator();
  a.sample(0, sample(2e9, 1e9));
  a.sample(3_600_000, sample(4e9, 2e9));
  return { schemaVersion: 1, jobId, pool: 'codex-personal', startedAt: '2026-10-26T00:00:00Z', finishedAt: '2026-10-26T01:00:00Z', memory: a.summary() };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('job memory accounting', () => {
  it('sums descendants exactly once, excludes neighbors, and attributes swap', () => {
    expect(processTreeMemory(1, [sample(10, 2), { pid: 3, ppid: 2, rssBytes: 30, swapBytes: 4 },
      { pid: 2, ppid: 1, rssBytes: 20, swapBytes: 3 }, { pid: 4, ppid: 0, rssBytes: 999, swapBytes: 999 }]))
      .toEqual(sample(60, 9));
    expect(processTreeMemory(9, [sample(10)])).toBeNull();
    expect(processTreeMemory(1, [sample(10), { pid: 2, ppid: 1, rssBytes: 20, swapBytes: null }])?.swapBytes).toBeNull();
  });
  it('weights irregular intervals and uses decimal GB-hour units', () => {
    const a = new JobMemoryAccumulator();
    a.sample(0, sample(1e9, 0.5e9));
    a.sample(3_600_000, sample(3e9, 1e9));
    a.sample(10_800_000, sample(2e9, 0));
    expect(a.summary()).toMatchObject({ sampleCount: 3, observedMs: 10_800_000,
      peakRssBytes: 3e9, averageRssBytes: 7e9 / 3, rssGbHours: 7,
      peakSwapBytes: 1e9, averageSwapBytes: 2.5e9 / 3, swapGbHours: 2.5 });
  });
  it('does not invent coverage over failed samples or unavailable swap', () => {
    const a = new JobMemoryAccumulator();
    expect(a.summary().averageRssBytes).toBeNull();
    a.sample(0, sample(10, null));
    a.sample(100, null);
    a.sample(200, sample(20));
    a.sample(300, sample(30));
    expect(a.summary()).toMatchObject({ observedMs: 100, averageRssBytes: 20, peakSwapBytes: null, swapGbHours: null });
    expect(() => a.sample(300, sample(2))).toThrow();
    expect(() => a.sample(400, sample(-1))).toThrow();
  });
  it('writes validated jobs.jsonl with a trailing newline and preserves the schema', async () => {
    const row = record();
    await appendMemoryJobRecord('/tmp/accounting-test/jobs.jsonl', row);
    expect(appendFile).toHaveBeenCalledWith('/tmp/accounting-test/jobs.jsonl', `${JSON.stringify(row)}\n`, { mode: 0o600 });
    expect(isMemoryJobRecord(JSON.parse(JSON.stringify(row)))).toBe(true);
    for (const invalid of [null, {}, { ...row, schemaVersion: 2 }, { ...row, finishedAt: 'bad' },
      { ...row, memory: { ...row.memory, rssGbHours: 99 } },
      { ...row, memory: { ...row.memory, peakRssBytes: Infinity } }]) {
      expect(isMemoryJobRecord(invalid)).toBe(false);
    }
    await expect(appendMemoryJobRecord('jobs.jsonl', {} as MemoryJobRecord)).rejects.toThrow();
  });
  it('counts impact only from the authenticated set and includes failed jobs in cost', () => {
    expect(computeMemoryImpact([record(), record('failed')], new Set(['job']))).toMatchObject({
      jobs: 2, impact: 1, rssGbHours: 4, impactPerGbHour: 0.25,
    });
    expect(computeMemoryImpact([], new Set()).impactPerGbHour).toBeNull();
    expect(computeMemoryImpact([record(), record()], new Set(['job'])).sourceQuality.complete).toBe(false);
  });
  it('turns sampler failures into missing coverage and drains an in-flight probe', async () => {
    vi.useFakeTimers();
    let at = 0;
    let resolve: ((value: ReturnType<typeof sample>) => void) | undefined;
    const probe = vi.fn().mockRejectedValueOnce(new Error('ps failed'))
      .mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const sampler = startJobMemorySampling(1, { sample: probe, now: () => at, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    at = 100;
    await vi.advanceTimersByTimeAsync(100);
    const stopped = sampler.stop();
    resolve!(sample(50, null));
    expect(await stopped).toMatchObject({ sampleCount: 1, observedMs: 0, averageRssBytes: null, peakSwapBytes: null });
    await vi.advanceTimersByTimeAsync(500);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('serializes probes, drains on stop, and cancels future polling', async () => {
    vi.useFakeTimers();
    let at = 0;
    const probe = vi.fn(async () => sample(1e9));
    const sampler = startJobMemorySampling(1, { sample: probe, now: () => at, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    at = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect((await sampler.stop()).observedMs).toBe(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
