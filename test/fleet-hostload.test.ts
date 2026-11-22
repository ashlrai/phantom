import { expect, it, vi } from 'vitest';
import { cmdFleetHostload } from '../src/cli/fleet-hostload.js';
import { groupHostFamilies, readHostFamilies } from '../src/core/fleet/host-families.js';
import { cmdFleetLeftovers } from '../src/cli/fleet-leftovers.js';
import { readHostLoadReport } from '../src/core/fleet/host-load.js';
import type { LeftoverEvidence } from '../src/core/fleet/host-leftovers.js';

const fixture = `PID PPID %CPU RSS ELAPSED COMMAND
10 1 2 1024 01:00 worker /repo/wt/RQ-WORK privateword
11 10 60 2048 00:10 tsgo plainarg
12 11 5 1024 00:01 child hiddenword
20 1 3 1024 01:00 claude RQ-CL-DOCS-123 privateword
21 20 40 1024 00:10 vitest plainarg
30 1 4 1024 01:00 worker /repo/wt/guardian-main privateword
40 50 50 1024 01:00 python oMLX serve plainarg
41 40 10 1024 00:10 child hiddenword
50 1 9 1024 01:00 /Applications/Editor.app/Contents/MacOS/Editor
51 50 1 1024 00:10 helper plainarg
60 50 6 1024 00:10 node --test plainarg
61 1 7 1024 00:10 tsc /repo/wt/RQ-CHECK/plain
70 999 8 1024 00:10 unknown privateword
71 72 1 1024 00:10 cycle plainarg
72 71 1 1024 00:10 cycle hiddenword`;

it('attributes test children to workers and Claude loops, and keeps only family metadata', () => {
  const report = groupHostFamilies(fixture), by = (family: string) => report.families.find(r => r.family === family);
  expect(by('fleet worker')).toEqual({ family: 'fleet worker', job: 'RQ-WORK', processes: 3, cpuPercent: 67, rssMb: 4 });
  expect(by('claude loop')).toMatchObject({ job: 'RQ-CL-DOCS-123', processes: 2, cpuPercent: 43 });
  expect(by('main guardian')).toMatchObject({ job: 'guardian-main', cpuPercent: 4 });
  expect(by('local model')).toMatchObject({ processes: 2, cpuPercent: 60 });
  expect(by('desktop apps')).toMatchObject({ processes: 2, cpuPercent: 10 });
  expect(by('other')).toMatchObject({ processes: 3, cpuPercent: 10 });
  expect(report.families.filter(r => r.family === 'typecheck/test').map(r => r.job)).toEqual(['RQ-CHECK', null]);
  expect(JSON.stringify(report)).not.toMatch(/privateword|plainarg|hiddenword|Applications|command|Editor|tsgo/);
});

const leftoverTable = `PID PPID %CPU RSS ELAPSED COMMAND
80 1 60 1024 01:00 /bin/tsgo plainword
81 1 30 1024 1-01:02:03 eslint hiddenword
82 1 10 1024 00:10 bun test privateword
83 1 20 1024 00:10 vitest hiddenword
84 1 20 1024 00:10 tsc hiddenword
85 80 5 1024 00:10 child hiddenword
86 1 20 1024 00:10 tsc hiddenword`;
const leftoverEvidence: LeftoverEvidence = { worktreeRoot: '/home/Projects/ashlrai/wt',
  cwds: new Map([[80, '/home/Projects/ashlrai/wt/done/src'], [81, '/home/Projects/ashlrai/wt/done'],
    [82, '/home/Projects/ashlrai/wt/live'], [83, '/home/Projects/ashlrai/wt-other/done'],
    [84, '/home/Projects/ashlrai/wt/unsure'], [85, '/home/Projects/ashlrai/wt/done'], [86, '/home/Projects/ashlrai/wt/old']]),
  liveJobs: new Map([['done', false], ['old', false], ['live', true], ['unsure', null]]) };

it('uses parent, cwd and dead-job evidence; never exposes arguments', async () => {
  const host = groupHostFamilies(leftoverTable, leftoverEvidence);
  expect(host.leftovers).toMatchObject({ state: 'unknown', processes: 3, cpuPercent: 110, jobs: ['done', 'old'] });
  expect(host.leftovers?.items).toEqual([
    { pid: 80, job: 'done', tool: 'tsgo', cpu: 60, ageSeconds: 60 },
    { pid: 81, job: 'done', tool: 'eslint', cpu: 30, ageSeconds: 90123 },
    { pid: 86, job: 'old', tool: 'tsc', cpu: 20, ageSeconds: 10 },
  ]);
  expect(host.families.find(r => r.family === 'leftover from finished jobs')).toMatchObject({ jobs: ['done', 'old'], processes: 3, cpuPercent: 110 });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetLeftovers(['--json'], async () => host)).toBe(1);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0])).items).toEqual(host.leftovers?.items);
    expect(JSON.stringify(host) + String(out.mock.calls.at(-1)![0])).not.toMatch(/plainword|hiddenword|privateword|command/);
    expect(await cmdFleetLeftovers(['--bad'])).toBe(2);
  } finally { out.mockRestore(); }
  const ps = leftoverTable.replace(/^(\s*\d+\s+\d+\s+[\d.]+\s+\d+)\s+\S+\s+/gm, '$1 ');
  const report = await readHostLoadReport({ ps: async () => ps, jobRoots: () => [], leftovers: leftoverEvidence }, { byTree: true });
  expect(report.trees?.fleetCpuPercent).toBe(115);
  expect(report.owners?.fleetSharePercent).toBeGreaterThan(50);
});

it('caps job ids at five without dropping leftover totals', () => {
  const cwds = new Map(Array.from({ length: 6 }, (_, i) => [i + 10, `/root/job${i}`]));
  const host = groupHostFamilies(Array.from(cwds, ([pid]) => `${pid} 1 10 1024 00:01 tsgo hiddenword`).join('\n'),
    { worktreeRoot: '/root', cwds, liveJobs: new Map(Array.from(cwds.values(), cwd => [cwd.slice(6), false])) });
  expect(host.leftovers).toMatchObject({ state: 'known', processes: 6, cpuPercent: 60 });
  expect(host.leftovers?.jobs).toHaveLength(5);
});

it('bounds CLI JSON and text, rejects bad flags, and keeps read failures private', async () => {
  const ps = async () => fixture + Array.from({ length: 100 }, (_, i) => `\n${100 + i} 1 1 1024 00:01 worker /repo/wt/RQ-WORK-${i}`).join('');
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await cmdFleetHostload(['--json'], ps)).toBe(0);
    const json = String(out.mock.calls.at(-1)![0]);
    expect(Buffer.byteLength(json)).toBeLessThan(4096); expect(JSON.parse(json).omitted).toBe(100);
    expect(await cmdFleetHostload([], ps)).toBe(0); expect(String(out.mock.calls.at(-1)![0]).split('\n')).toHaveLength(8);
    expect(await cmdFleetHostload(['--bad'], ps)).toBe(2);
    expect(await cmdFleetHostload(['--json'], async () => { throw new Error('privateword'); })).toBe(1);
    expect(String(out.mock.calls.at(-1)![0])).not.toContain('privateword');
    expect(await readHostFamilies(async () => null)).toEqual({ state: 'unknown', families: [], omitted: 0 });
  } finally { out.mockRestore(); err.mockRestore(); }
});
