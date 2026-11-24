import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeLiveJobs, type LiveJob, type LiveJobsReport } from '../src/core/fleet/live-jobs.js';
import { readCompactBrief, compactBriefLines } from '../src/core/fleet/leader-compact-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
import * as backlog from '../src/core/release/backlog.js';
import * as latency from '../src/core/fleet/git-merge-latency.js';

const now = Date.parse('2026-11-21T12:00:00Z'), at = new Date(now).toISOString();
let dir: string, file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapshot-brief-')); file = join(dir, 'queue/live-jobs.json');
  vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: at, counts: { ok: 1, due: 2, stale: 3, unknown: 1 }, repos: [] });
  vi.spyOn(latency, 'readGitMergeLatency').mockResolvedValue(latency.mergeLatencyFromGit([], [], now / 1000));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const job = (id: string, status: LiveJob['status'], elapsed: number): LiveJob => ({ id, lane: 'fake', repo: 'fake', started: at, elapsed, lastLogWrite: at, lastLine: 'fake', status, process: 'live' });
const report = (known: boolean, jobs: LiveJob[]): LiveJobsReport => ({ schema: 'jobs.live.v1', generatedAt: at, known, jobs });
const read = () => readCompactBrief(dir, now, async () => groupHostFamilies(null));
const line = (brief: Awaited<ReturnType<typeof read>>) => compactBriefLines(brief).find(s => s.startsWith('Quiet/stuck:'));

it('reads the writer snapshot, prioritizes stuck jobs, and preserves other fields', async () => {
  await writeLiveJobs(file, report(true, [job('quiet', 'quiet', 1000), job('stuck-short', 'stuck', 2), job('stuck-long', 'stuck', 5), job('stale', 'stale', 9999), job('unknown', 'unknown', 9999), job('stuck-3', 'stuck', 3), job('stuck-4', 'stuck', 4), job('stuck-1', 'stuck', 1)]));
  const brief = await read();
  expect(brief.attention.map(j => [j.id, j.status])).toEqual([['stuck-long', 'stuck'], ['stuck-4', 'stuck'], ['stuck-3', 'stuck'], ['stuck-short', 'stuck'], ['stuck-1', 'stuck']]);
  expect(line(brief)).toBe('Quiet/stuck: stuck-long, stuck-4, stuck-3, stuck-short, stuck-1');
  expect(brief.liveAt).toBe(at); expect(brief.release).toMatchObject({ due: 2, stale: 3 });
  await writeLiveJobs(file, report(true, [job('quiet', 'quiet', 1000), job('stuck', 'stuck', 1), job('stale', 'stale', 9999), job('unknown', 'unknown', 9999)]));
  expect(line(await read())).toBe('Quiet/stuck: stuck, quiet');
});
it('distinguishes unknown and malformed observations from a known empty snapshot', async () => {
  await writeLiveJobs(file, report(false, [job('stuck', 'stuck', 1)]));
  let brief = await read(); expect(brief.attention).toEqual([]); expect(line(brief)).toBe('Quiet/stuck: unknown'); expect(brief.liveAt).toBe(at);
  await writeFile(file, '{'); brief = await read(); expect(brief.sources['queue/live-jobs.json'].state).toBe('degraded'); expect(line(brief)).toBe('Quiet/stuck: unknown');
  await writeFile(file, JSON.stringify({ known: true, running: null })); brief = await read(); expect(line(brief)).toBe('Quiet/stuck: unknown');
  await writeLiveJobs(file, report(true, [])); brief = await read(); expect(line(brief)).toBe('Quiet/stuck: none recorded');
});
