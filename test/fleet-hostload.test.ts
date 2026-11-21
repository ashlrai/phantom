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
  expect(by('other')).toMatchObject({ processes: 3, cpuPercent: 10 });
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
    expect(await cmdFleetHostload([], ps)).toBe(0); expect(String(out.mock.calls.at(-1)![0]).split('\n')).toHaveLength(8);
    expect(await cmdFleetHostload(['--bad'], ps)).toBe(2);
    expect(await cmdFleetHostload(['--json'], async () => { throw new Error('privateword'); })).toBe(1);
    expect(String(out.mock.calls.at(-1)![0])).not.toContain('privateword');
    expect(await readHostFamilies(async () => null)).toEqual({ state: 'unknown', families: [], omitted: 0 });
  } finally { out.mockRestore(); err.mockRestore(); }
});
