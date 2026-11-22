import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHostload } from '../src/cli/fleet-hostload.js';
import { readHostFamilies } from '../src/core/fleet/host-families.js';
import { compactBriefLines, readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import * as backlog from '../src/core/release/backlog.js';
import * as latency from '../src/core/fleet/git-merge-latency.js';

const now = Date.parse('2026-11-21T12:00:00Z');
// Every process and runtime source is synthetic; no real ps or fleet state is read.
const processes = `10 1 2 1024 00:01 worker /synthetic/wt/RQ-OWNER
11 10 3 2048 00:01 python3 private-argument
12 11 4 1024 00:01 /Applications/Docker.app/Contents/MacOS/Docker
20 1 60 4096 00:01 docker private-argument
30 1 40 2048 00:01 chrome private-argument
40 1 10 1024 00:01 /synthetic/bin/mystery private-argument
41 1 5 2048 00:01 /elsewhere/mystery private-argument`;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-owner-756s-'));
  await mkdir(join(dir, 'queue'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: new Date(now).toISOString(), counts: { ok: 0, due: 0, stale: 0, unknown: 0 }, repos: [] });
  vi.spyOn(latency, 'readGitMergeLatency').mockResolvedValue(latency.mergeLatencyFromGit([], [], now / 1000));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const host = () => readHostFamilies(async () => processes);

it('preserves owner attribution through the real reader, CLI and compact brief', async () => {
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), admission: { disabled: false, load1: 45, load_max: 36 } }));
  const report = await host();
  expect(report.families.find(r => r.job === 'RQ-OWNER')).toMatchObject({ processes: 3, cpuPercent: 9, rssMb: 4 });
  expect(report.families.find(r => r.family === 'Docker/virtualization')).toMatchObject({ processes: 1, cpuPercent: 60 });
  expect(report.unknownCommands).toEqual([{ name: 'mystery', processes: 2, cpuPercent: 15, rssMb: 3 }]);
  const brief = await readCompactBrief(dir, now, host);
  expect(brief.hostLoadWarning).toContain('Docker/virtualization and browsers');
  expect(brief.hostLoadWarning).toContain('CPU-share estimate');
  expect(compactBriefLines(brief)[1]).toBe(brief.hostLoadWarning);
  expect(brief.release).toEqual({ ok: 0, due: 0, stale: 0, unknown: 0 });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetHostload([], async () => processes)).toBe(0);
  expect(output.mock.calls[0]![0]).toContain('mystery (2 processes, 15% CPU, 3 MB RSS)');
  expect(await cmdFleetHostload(['--json'], async () => processes)).toBe(0);
  expect(JSON.parse(String(output.mock.calls[1]![0]))).toEqual(report);
  expect(JSON.stringify({ report, brief, lines: compactBriefLines(brief), output: output.mock.calls })).not.toMatch(/private-argument|synthetic|elsewhere|Applications|MacOS|python3/);
});

it.each(['missing', 'stale', 'disabled', 'unspecified', 'fleet-dominant', 'unavailable'])(
  'withholds warnings for %s evidence', async mode => {
    if (mode !== 'missing') await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
      last_tick: new Date(now - (mode === 'stale' ? 120_000 : 0)).toISOString(),
      admission: { load1: 45, load_max: 36, ...(mode === 'unspecified' ? {} : { disabled: mode === 'disabled' }) },
    }));
    const reader = mode === 'unavailable' ? () => readHostFamilies(async () => { throw new Error('/synthetic/private-argument'); })
      : mode === 'fleet-dominant' ? () => readHostFamilies(async () => processes.replace('10 1 2 ', '10 1 200 ')) : host;
    const brief = await readCompactBrief(dir, now, reader);
    expect(brief.hostLoadWarning).toBeNull();
    expect(JSON.stringify(brief)).not.toMatch(/private-argument|synthetic/);
    expect(compactBriefLines(brief).join('\n')).not.toContain('starts slowed');
  },
);
