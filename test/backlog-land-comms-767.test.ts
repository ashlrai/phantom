import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
import { compactBriefLines, readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import * as backlog from '../src/core/release/backlog.js';
import * as latency from '../src/core/fleet/git-merge-latency.js';

// Warning integration from #8095, reconciled with master's named executables and leftovers.
const now = Date.parse('2026-11-21T12:00:00Z');
const processes = `10 1 2 1024 00:01 worker /synthetic/wt/RQ-OWNER
11 10 3 2048 00:01 python3 private-argument
12 11 4 1024 00:01 /Applications/Docker.app/Contents/MacOS/Docker
20 1 60 4096 00:01 docker private-argument
30 1 40 2048 00:01 chrome private-argument`;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'comms-767-'));
  await mkdir(join(dir, 'queue'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: new Date(now).toISOString(), counts: { ok: 0, due: 0, stale: 0, unknown: 0 }, repos: [] });
  vi.spyOn(latency, 'readGitMergeLatency').mockResolvedValue(latency.mergeLatencyFromGit([], [], now / 1000));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const status = (admission: object, age = 0) => writeFile(join(dir, 'queue/status.json'), JSON.stringify({
  last_tick: new Date(now - age).toISOString(), admission,
}));

it('carries the warning through the brief without exposing process arguments', async () => {
  await status({ disabled: false, load1: 45, load_max: 36 });
  const host = groupHostFamilies(processes);
  expect(host.families.find(r => r.job === 'RQ-OWNER')).toMatchObject({ processes: 3, cpuPercent: 9, rssMb: 4 });
  expect(host).toMatchObject({ fleetCpuPercent: 9, totalCpuPercent: 109 });
  const brief = await readCompactBrief(dir, now, async () => host);
  expect(brief.hostLoadWarning).toBe('Mac busy with docker and chrome (load 45, fleet about 4, CPU-share estimate): starts slowed');
  expect(compactBriefLines(brief)[1]).toBe(brief.hostLoadWarning);
  expect(brief.release).toEqual({ ok: 0, due: 0, stale: 0, unknown: 0 });
  expect(JSON.stringify(brief)).not.toMatch(/private-argument|synthetic|Applications|MacOS|python3/);
});

it.each(['missing', 'stale', 'disabled', 'unspecified', 'fleet-dominant', 'unavailable'])(
  'withholds warnings for %s evidence', async mode => {
    if (mode !== 'missing') await status({ load1: 45, load_max: 36,
      ...(mode === 'unspecified' ? {} : { disabled: mode === 'disabled' }),
    }, mode === 'stale' ? 120_000 : 0);
    const host = groupHostFamilies(mode === 'unavailable' ? null
      : mode === 'fleet-dominant' ? processes.replace('10 1 2 ', '10 1 200 ') : processes);
    const brief = await readCompactBrief(dir, now, async () => host);
    expect(brief.hostLoadWarning).toBeNull();
    expect(compactBriefLines(brief).join('\n')).not.toContain('starts slowed');
  },
);

it('uses totals before the eight-family display cap and includes finished-job load as fleet', async () => {
  const text = Array.from({ length: 10 }, (_, i) => `${100 + i} 1 20 1024 00:01 worker /synthetic/wt/RQ-${i}`).join('\n');
  const capped = groupHostFamilies(text);
  expect(capped.families).toHaveLength(8);
  expect(capped).toMatchObject({ omitted: 2, fleetCpuPercent: 200, totalCpuPercent: 200 });
  const host = groupHostFamilies(`${processes}\n40 1 200 1024 00:01 tsgo private-argument`, {
    worktreeRoot: '/synthetic/wt', cwds: new Map([[40, '/synthetic/wt/done']]), liveJobs: new Map([['done', false]]),
  });
  expect(host).toMatchObject({ fleetCpuPercent: 209, totalCpuPercent: 309 });
  await status({ disabled: false, load1: 45, load_max: 36 });
  const brief = await readCompactBrief(dir, now, async () => host);
  expect(brief.hostLoadWarning).toBeNull();
  expect(brief.hostLoad.leftovers?.cpuPercent).toBe(200);
  expect(JSON.stringify(brief.hostLoad)).not.toContain('"items"');
});
