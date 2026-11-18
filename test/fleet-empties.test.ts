import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetEmpties, fleetEmpties } from '../src/cli/fleet-empties.js';
import { EMPTY_FINISH_CAUSES, readFleetEmpties } from '../src/core/fleet/empties.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const now = Date.parse('2026-11-17T12:00:00Z');
const row = (fields: object, age = 100) => JSON.stringify({ job: 'RQ-A1', lane: 'codex', ts: new Date(now - age * 1000).toISOString(), ...fields });
const finish = (fields: object = {}, age = 100) => row({ event: 'finish', empty: true, wall_s: 90, ...fields }, age);
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

it('classifies all six causes from explicit metrics, notes and duration in stable key order', async () => {
  const reasons = ['Already merged into main.', 'gh not logged in', 'Precheck refused the job.', '', 'Scope was unclear.', 'no candidate'];
  const fixture = reasons.map((reason, i) => finish({ job: `RQ-FAMILY${i}`, reason: i === 4 ? undefined : reason, notes_path: i === 4 ? 'result.md' : undefined, wall_s: i === 3 ? 59 : 90 })).join('\n');
  const notes = vi.fn(async () => 'Scope was unclear.');
  const report = await fleetEmpties(async () => fixture, 24, now, notes);
  expect(report.empties.map(e => e.cause)).toEqual(EMPTY_FINISH_CAUSES);
  expect(report.byCause).toEqual(Object.fromEntries(EMPTY_FINISH_CAUSES.map(c => [c, 1])));
  expect(report.groups).toEqual([{ family: 'RQ-FAMILY', lane: 'codex', finished: 6, measured: 6, empty: 6, emptyRate: 1 }]);
  expect(report.topFamilies).toEqual([{ family: 'RQ-FAMILY', empty: 6 }]);
  expect(notes).toHaveBeenCalledExactlyOnceWith('result.md');
  expect(Object.keys(report)).toEqual(['schema', 'windowHours', 'known', 'malformedLines', 'notesMissing', 'launches', 'finished', 'measured', 'total', 'emptyRate', 'byCause', 'groups', 'topFamilies', 'empties']);
  expect(Object.keys(report.byCause)).toEqual(EMPTY_FINISH_CAUSES);
  expect(JSON.stringify(await fleetEmpties(async () => fixture, 24, now, notes))).toBe(JSON.stringify(report));
});
it('counts repeated attempts, ignores duplicate rows and uses only matching launch and publication evidence', async () => {
  const fixture = [row({ event: 'launch' }, 90_010), finish({ wall_s: undefined }, 86_390), row({ event: 'launch', lane: 'claude' }, 130),
    finish({ lane: undefined, wall_s: undefined }, 100), finish({ lane: undefined, wall_s: undefined }, 100),
    row({ event: 'publish', lane: 'claude', url: 'https://github.com/ashlrai/phantom/pull/1' }, 99),
    row({ event: 'outcome', lane: 'claude', state: 'EMPTY_DONE' }, 98), row({ event: 'launch' }, 80), finish({ empty: false }, 10),
    finish({ job: 'RQ-B1', empty: undefined }), row({ event: 'launch', job: 'RUNNING1' }, 2)].join('\n');
  const r = await fleetEmpties(async () => fixture, 24, now);
  expect(r).toMatchObject({ launches: 3, finished: 4, measured: 3, total: 2, emptyRate: 2 / 3 });
  expect(r.empties).toMatchObject([{ lane: 'codex', wallSeconds: 3620, cause: 'unknown' }, { lane: 'claude', wallSeconds: 30, cause: 'unknown', evidence: 'conflicting evidence' }]);
  expect(r.topFamilies).toEqual([{ family: 'RQ-A', empty: 2 }]);
});
it('does not guess from negations, generic failures, conflicting reasons or the 60-second boundary', async () => {
  const reasons = ['not already done on main', 'gh available', 'precheck passed', 'scope clear', 'no_diff', 'Already merged into main.\nScope unclear.'];
  const r = await fleetEmpties(async () => reasons.map((reason, i) => finish({ job: `J${i}`, reason, wall_s: 60 })).join('\n'), 24, now);
  expect(r.byCause.unknown).toBe(6);
  expect((await fleetEmpties(async () => finish({ reason: 'refused-by-precheck', wall_s: 1 }), 24, now)).empties[0]?.cause).toBe('refused-by-precheck');
  for (const wall_s of [undefined, 60, 90]) expect((await fleetEmpties(async () => finish({ cause: 'too-fast-to-have-worked', wall_s }), 24, now)).empties[0]).toMatchObject({ cause: 'unknown', evidence: 'conflicting evidence' });
});
it('uses published finishes in the rate and never borrows evidence across overlapping lanes', async () => {
  const fixture = [row({ event: 'launch', notes_path: 'wrong.md' }, 200), row({ event: 'launch', lane: 'claude' }, 180),
    finish({ lane: 'claude', wall_s: undefined }, 100), finish({ empty: undefined }, 90),
    row({ event: 'publish', pr_url: 'https://github.com/ashlrai/phantom/pull/2/' }, 80)].join('\n');
  const notes = vi.fn(async () => 'Scope unclear.');
  const r = await fleetEmpties(async () => fixture, 24, now, notes);
  expect(r).toMatchObject({ finished: 2, measured: 2, total: 1, emptyRate: 0.5 });
  expect(r.empties[0]).toMatchObject({ lane: 'claude', wallSeconds: 80, cause: 'unknown' });
  expect(notes).not.toHaveBeenCalled();
});
it('filters time and malformed rows, ranks five families deterministically and distinguishes missing data', async () => {
  const fixture = ['{', 'null', '[]', finish({ ts: 'bad' }), finish({}, 86401), finish({}, -1), ...'HGFEDCBA'.split('').map(job => finish({ job }))].join('\n');
  const r = await fleetEmpties(async () => fixture, 24, now);
  expect(r).toMatchObject({ total: 8, malformedLines: 4 });
  expect(r.topFamilies.map(g => g.family)).toEqual(['A', 'B', 'C', 'D', 'E']);
  expect(await fleetEmpties(async () => '', 24, now)).toMatchObject({ known: true, total: 0, emptyRate: null, groups: [], topFamilies: [] });
  expect(await fleetEmpties(async () => finish({}, 86401), 24, now)).toMatchObject({ total: 0 });
  expect(await fleetEmpties(async () => { throw Error(); }, 24, now)).toMatchObject({ known: false, total: null, launches: null });
});
it('reads only explicitly named bounded notes inside runs; never follows symlinks or reads inferred logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-report-')); roots.push(root); await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'result.md'), 'Cause: already-done-on-main'); await symlink(join(root, 'result.md'), join(root, 'link.md'));
  await writeFile(join(root, 'large.md'), 'Scope unclear.\n'.repeat(1000));
  await writeFile(join(root, 'late.md'), 'x'.repeat(3000) + '\nScope unclear.');
  const paths = ['result.md', 'link.md', 'large.md', 'late.md', '../outside.md', 'missing.md', undefined];
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), paths.map((notes_path, i) => finish({ job: `J${i}`, notes_path })).join('\n'));
  await writeFile(join(root, 'J6.log'), 'Cause: scope-unclear');
  const r = await readFleetEmpties(24, now, root);
  expect(r).toMatchObject({ total: 7, notesMissing: 4, byCause: { 'already-done-on-main': 1, unknown: 6 } });
  expect(JSON.stringify(r)).not.toContain(root);
});
it('registers one CLI, validates before reads, defaults to JSON and renders a plain short table', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS.empties!()).cmdFleetEmpties).toBe(cmdFleetEmpties);
  const read = vi.fn(async () => finish({ reason: 'scope-unclear' }));
  for (const args of [['--since'], ['--since', '0h'], ['--since', '1d'], ['--since', '2161h'], ['--json', '--json'], ['--human', '--json'], ['bad']]) expect(await cmdFleetEmpties(args, read, now)).toBe(2);
  expect(read).not.toHaveBeenCalled();
  expect(await cmdFleetEmpties([], read, now)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ schema: 'fleet.empties.v2', total: 1 });
  expect(await cmdFleetEmpties(['--human'], read, now)).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('Family | Lane | Empty | Measured | Empty rate');
  expect(log.mock.calls.at(-1)![0]).toContain('scope unclear: 1');
  expect(await cmdFleetEmpties([], async () => null, now)).toBe(1);
});
