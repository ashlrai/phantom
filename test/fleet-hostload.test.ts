import { expect, it, vi } from 'vitest';
import { cmdFleetHostload } from '../src/cli/fleet-hostload.js';
import { groupHostFamilies, readHostFamilies } from '../src/core/fleet/host-families.js';
import { cmdFleetLeftovers } from '../src/cli/fleet-leftovers.js';
import { readHostLoadReport } from '../src/core/fleet/host-load.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLeftoverJobStates, type LeftoverEvidence } from '../src/core/fleet/host-leftovers.js';

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
  expect(by('Editor')).toMatchObject({ processes: 2, cpuPercent: 10 });
  expect(by('other')).toMatchObject({ processes: 3, cpuPercent: 10 });
  expect(report.families.filter(r => r.family === 'typecheck/test').map(r => r.job)).toEqual(['RQ-CHECK', null]);
  expect(JSON.stringify(report)).not.toMatch(/privateword|plainarg|hiddenword|Applications|command|tsgo/);
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
    expect(await cmdFleetHostload([], ps)).toBe(0); expect(String(out.mock.calls.at(-1)![0]).split('\n')).toHaveLength(9);
    expect(await cmdFleetHostload(['--bad'], ps)).toBe(2);
    expect(await cmdFleetHostload(['--json'], async () => { throw new Error('privateword'); })).toBe(1);
    expect(String(out.mock.calls.at(-1)![0])).not.toContain('privateword');
    expect(await readHostFamilies(async () => null)).toMatchObject({ state: 'unknown', families: [], omitted: 0, blame: expect.stringContaining('unknown') });
  } finally { out.mockRestore(); err.mockRestore(); }
});

it('names busy executable families, folds app helpers and Spotlight, and blames the top two', () => {
  const table = [
    [10, 1, 100, '/System/mds'], [11, 1, 50, '/System/mdworker'], [12, 1, 40, '/System/mdworker_shared'],
    [20, 1, 20, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    [21, 1, 100, '/Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper'],
    [30, 1, 25, '/bin/node'], [31, 1, 25, '/bin/node'], [40, 1, 10, 'worker'],
    [50, 1, 19.9, '/bin/git'], [51, 1, 0.1, '/bin/git'], [60, 1, 30, '/bin/python3'],
    [70, 1, 20, 'kernel_task'], [71, 1, 20, 'WindowServer'], [72, 1, 20, 'backupd'],
    [73, 1, 20, 'Code Helper'], [74, 1, 5, 'idle'],
  ].map(([pid, ppid, cpu, exe]) => `${pid} ${ppid} ${cpu} 1024 00:01 ${String(exe).padEnd(1024)} ${exe} ${pid === 40 ? '/repo/wt/work' : 'hiddenword /Applications/Decoy.app/Contents/plain'}`).join('\n');
  const host = groupHostFamilies(`PID PPID %CPU RSS ELAPSED ${'COMM'.padEnd(1024)} COMMAND\n${table}`, undefined, { load1: 25, cores: 18 });
  expect(host.families.slice(0, 3)).toEqual([
    { family: 'Spotlight', job: null, processes: 3, cpuPercent: 190, rssMb: 3 },
    { family: 'Google Chrome', job: null, processes: 2, cpuPercent: 120, rssMb: 2 },
    { family: 'node', job: null, processes: 2, cpuPercent: 50, rssMb: 2 },
  ]);
  expect(host.families.find(r => r.family === 'git')).toMatchObject({ processes: 2, cpuPercent: 20, rssMb: 2 });
  expect(host.families).toHaveLength(8); expect(host.omitted).toBe(3);
  expect(host.blame).toBe('load1 25 on 18 cores: Spotlight 190%, Google Chrome 120%, fleet 10%');
  expect(JSON.stringify(host)).not.toMatch(/hiddenword|Applications|Decoy|Contents|command/);
  expect(groupHostFamilies('10 1 19 1024 00:01 node plain\n11 1 19 1024 00:01 git plain').families)
    .toEqual([{ family: 'other', job: null, processes: 2, cpuPercent: 38, rssMb: 2 }]);
});

it('keeps live jobs out of leftovers and honors finish rows, missing claims and relaunches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-jobs-'));
  try {
    await mkdir(join(dir, 'queue/run'), { recursive: true }); await mkdir(join(dir, 'metrics'));
    for (const job of ['live', 'done', 'again']) await writeFile(join(dir, `queue/run/${job}.pid`), '90\n');
    await writeFile(join(dir, 'queue/run/bad.pid'), 'plain');
    await writeFile(join(dir, 'queue/run/gone.pid'), '91');
    await writeFile(join(dir, 'metrics/jobs.jsonl'), [null, { event: 'launch', job: 'live' },
      { type: 'finish', job_id: 'done' }, { event: 'finish', job: 'again' }, { event: 'launch', job: 'again' }].map(r => JSON.stringify(r)).join('\n'));
    const liveJobs = await readLeftoverJobStates(['live', 'done', 'again', 'gone', 'missing', 'bad'], dir, pid => pid === 90);
    expect(Object.fromEntries(liveJobs)).toEqual({ live: true, done: false, again: true, gone: false, missing: false, bad: null });
    const host = groupHostFamilies('10 1 40 1024 00:01 node plain\n11 1 30 1024 00:01 node plain', {
      worktreeRoot: '/root', cwds: new Map([[10, '/root/live'], [11, '/root/done']]), liveJobs,
    });
    expect(host.leftovers?.items.map(r => r.pid)).toEqual([11]);
    expect(host.families.find(r => r.family === 'leftover from finished jobs')).toMatchObject({ processes: 1, cpuPercent: 30 });
    expect((await readLeftoverJobStates(['live'], join(dir, 'absent'))).get('live')).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
  ['Docker/virtualization', '/Applications/Docker.app/Contents/MacOS/Docker'], ['Docker/virtualization', '/usr/bin/qemu'],
  ['Spotlight/indexing', '/System/mds'], ['Spotlight/indexing', '/usr/libexec/mdworker_shared'], ['git', '/usr/bin/git'],
  ['Node/Vite', '/usr/bin/node'], ['Node/Vite', '/repo/node_modules/.bin/vite'],
  ['language servers', 'node /repo/typescript/tsserver.js'], ['language servers', 'node /repo/eslintServer.js'],
  ['Codex/Claude helpers', '/usr/bin/codex'], ['Codex/Claude helpers', '/usr/bin/claude'],
  ['browsers', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], ['browsers', '/usr/libexec/com.apple.WebKit.WebContent'],
  ['browsers', '/Applications/Safari.app/Contents/MacOS/Safari'], ['Python', '/usr/bin/python3'], ['unknown', '/usr/bin/plain'],
])('classifies %s by executable or server path', (family, command) => {
  const report = groupHostFamilies(`10 1 12 2048 00:01 ${command} hiddenword`);
  expect(report.families).toMatchObject([{ job: null, processes: 1, cpuPercent: 12, rssMb: 2 }]);
  expect(report.unknownCommands).toHaveLength(family === 'unknown' ? 1 : 0);
  expect(JSON.stringify(report)).not.toMatch(/hiddenword|\/usr|\/Applications|\/repo/);
});

it('aggregates unknown basenames and caps the CPU-sorted list at five without arguments', () => {
  const rows = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((name, i) => `${10 + i} 1 ${10 + i} 1024 00:01 /bin/${name} hiddenword`);
  rows.push('20 1 20 2048 00:01 /other/alpha privateword');
  const report = groupHostFamilies(rows.join('\n'));
  expect(report.unknownCommands.map(r => r.name)).toEqual(['alpha', 'foxtrot', 'echo', 'delta', 'charlie']);
  expect(report.unknownCommands[0]).toEqual({ name: 'alpha', processes: 2, cpuPercent: 30, rssMb: 3 });
  expect(JSON.stringify(report)).not.toMatch(/hiddenword|privateword|\/bin|\/other/);
});

it('keeps fleet ownership ahead of app families and never uses an argument as a display name', () => {
  const report = groupHostFamilies(`10 1 5 1024 00:01 /Applications/Docker.app/Contents/MacOS/Docker
11 10 6 1024 00:01 helper hiddenword
20 10 8 1024 00:01 worker /repo/wt/plain
21 20 9 1024 00:01 python3 privateword
30 1 2 1024 00:01 /bin/plain /repo/Hidden.app/Contents/MacOS/Hidden hiddenword`);
  expect(report.families.find(r => r.family === 'Docker')).toMatchObject({ processes: 2, cpuPercent: 11 });
  expect(report.families.find(r => r.family === 'fleet worker')).toMatchObject({ processes: 2, cpuPercent: 17 });
  expect(JSON.stringify(report)).not.toMatch(/Hidden|hiddenword|privateword|\/repo/);
});
