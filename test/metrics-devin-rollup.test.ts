import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRollup, rollupJobLanes } from '../src/core/observability/rollup.js';

vi.mock('../src/core/observability/usage-source.js', () => ({ collectUsageEvents: () => [] }));
vi.mock('../src/core/index-engine.js', () => ({ loadIndex: () => null }));

const now = Date.parse('2026-10-26T12:00:00Z');
const since = now - 86_400_000;
const homes: string[] = [];
function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'devin-rollup-'));
  homes.push(home);
  vi.stubEnv('ASHLR_HOME', home);
  copyFileSync(new URL('./fixtures/metrics-devin/jobs.jsonl', import.meta.url), join(home, 'jobs.jsonl'));
  return home;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('job lane rollups', () => {
  it('includes Devin in the activity rollup and keeps other lanes separate', () => {
    fixture();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const result = buildRollup('1d', {} as Parameters<typeof buildRollup>[1]);
    expect(result.byLane).toEqual([
      { lane: 'codex', jobs: 1, prs: 1, merged: 1, mergeRate: 1, wallTimePerJobMs: null, prsPerHour: 1 / 24 },
      { lane: 'devin', jobs: 2, prs: 2, merged: 1, mergeRate: 0.5, wallTimePerJobMs: 5_400_000, prsPerHour: 2 / 24 },
    ]);
    expect(rollupJobLanes(since, now, 'phantom')).toEqual([result.byLane![1]]);
    expect(rollupJobLanes(since, now, 'missing')).toEqual([]);
  });

  it('deduplicates PRs across jobs and excludes invalid durations', () => {
    const home = fixture();
    const rows = [
      { jobId: 'a', prUrl: 'pr1', merged: true, startedAt: 'invalid', completedAt: '2026-10-26T11:00:00Z' },
      { jobId: 'b', prUrl: 'pr1', startedAt: '2026-10-26T12:00:00Z', completedAt: '2026-10-26T11:00:00Z' },
      { jobId: 'c' },
    ].map(row => JSON.stringify({ lane: 'devin', ts: '2026-10-26T11:00:00Z', ...row }));
    writeFileSync(join(home, 'jobs.jsonl'), rows.join('\n'));
    expect(rollupJobLanes(since, now)).toEqual([
      { lane: 'devin', jobs: 3, prs: 1, merged: 1, mergeRate: 1, wallTimePerJobMs: null, prsPerHour: 1 / 24 },
    ]);
  });

  it('uses the newest snapshot regardless of append order and filters by completion time', () => {
    const home = fixture();
    const rows = [
      { jobId: 'a', ts: '2026-10-26T11:00:00Z', prUrl: 'pr1', merged: false },
      { jobId: 'a', ts: '2026-10-26T10:00:00Z', prUrl: 'pr1', merged: true },
      { jobId: 'b', ts: '2026-10-26T11:00:00Z', completedAt: '2026-10-01T10:00:00Z' },
      { jobId: 'c', ts: '2026-10-26T11:00:00Z', completedAt: 'invalid' },
      { jobId: 'd', ts: 'invalid' },
      { jobId: '', ts: '2026-10-26T11:00:00Z' },
    ].map(row => JSON.stringify({ lane: 'devin', ...row }));
    writeFileSync(join(home, 'jobs.jsonl'), rows.join('\n'));
    expect(rollupJobLanes(since, now)).toEqual([
      { lane: 'devin', jobs: 1, prs: 1, merged: 0, mergeRate: 0, wallTimePerJobMs: null, prsPerHour: 1 / 24 },
    ]);
    expect(rollupJobLanes(now - 7 * 86_400_000, now)[0]?.prsPerHour).toBe(1 / 168);
  });

  it('distinguishes no PR observations from a zero merge rate', () => {
    const home = fixture();
    writeFileSync(join(home, 'jobs.jsonl'), JSON.stringify({ lane: 'devin', jobId: 'a', ts: new Date(now).toISOString() }));
    expect(rollupJobLanes(since, now)[0]).toMatchObject({ mergeRate: null, wallTimePerJobMs: null, prsPerHour: 0 });
    rmSync(join(home, 'jobs.jsonl'));
    expect(rollupJobLanes(since, now)).toEqual([]);
  });
});
