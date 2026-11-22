import { expect, it, vi } from 'vitest';
import { cmdFleetHostload } from '../src/cli/fleet-hostload.js';
import { groupHostFamilies, readHostFamilies } from '../src/core/fleet/host-families.js';

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
  expect(by('unknown')).toMatchObject({ processes: 3, cpuPercent: 10 });
  expect(report.families.filter(r => r.family === 'typecheck/test').map(r => r.job)).toEqual(['RQ-CHECK', null]);
  expect(JSON.stringify(report)).not.toMatch(/privateword|plainarg|hiddenword|Applications|command|Editor|tsgo/);
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
    expect(String(out.mock.calls.at(-1)![0])).toContain('Unknown commands: unknown (1 processes, 8% CPU, 1 MB RSS)');
    expect(await cmdFleetHostload(['--bad'], ps)).toBe(2);
    expect(await cmdFleetHostload(['--json'], async () => { throw new Error('privateword'); })).toBe(1);
    expect(String(out.mock.calls.at(-1)![0])).not.toContain('privateword');
    expect(await readHostFamilies(async () => null)).toEqual({ state: 'unknown', families: [], omitted: 0, unknownCommands: [], fleetCpuPercent: 0, totalCpuPercent: 0 });
  } finally { out.mockRestore(); err.mockRestore(); }
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
  expect(report.families).toEqual([{ family, job: null, processes: 1, cpuPercent: 12, rssMb: 2 }]);
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
  expect(report.families.find(r => r.family === 'Docker/virtualization')).toMatchObject({ processes: 2, cpuPercent: 11 });
  expect(report.families.find(r => r.family === 'fleet worker')).toMatchObject({ processes: 2, cpuPercent: 17 });
  expect(JSON.stringify(report)).not.toMatch(/Hidden|hiddenword|privateword|\/repo/);
});
