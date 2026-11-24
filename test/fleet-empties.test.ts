import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetEmpties, fleetEmpties } from '../src/cli/fleet-empties.js';
import { EMPTY_FINISH_CAUSES, readFleetEmpties } from '../src/core/fleet/empties.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { classifyEmptyRun, emptiesWhyText, EMPTY_RUN_REASONS, readEmptiesWhy, rollupEmptyRuns, type EmptyRunInput, type EmptyRunReason } from '../src/core/fleet/empties-why.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
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

// ---------------------------------------------------------------------------
// RQ-EMPTYWHYN19NQ8: why each empty run ended empty (fleet.empties.why.v1).
// ---------------------------------------------------------------------------
describe('why runs ended empty', () => {
  const at = (age: number) => new Date(now - age * 1000).toISOString();
  const ev = (job: string, fields: object, age = 100) => ({ job, lane: 'claude', ts: at(age), ...fields });
  const input = (over: Partial<EmptyRunInput> = {}): EmptyRunInput => ({ job: 'RQ-WIDGET7', events: [ev('RQ-WIDGET7', { event: 'launch', tier: 'frontier' }), ev('RQ-WIDGET7', { event: 'finish', empty: true, tokens_total: 1000 })], log: 'reading files\nall done here', publish: null, launchNote: null, ...over });
  const finishWith = (fields: object) => [ev('RQ-WIDGET7', { event: 'launch', tier: 'frontier' }), ev('RQ-WIDGET7', { event: 'finish', empty: true, ...fields })];

  it('gives one reason per fixture, in the documented order', () => {
    const cases: Array<[EmptyRunReason, Partial<EmptyRunInput>, string | null]> = [
      ['plan_limit', { events: finishWith({ pool_error: 'usage_limit' }) }, 'pool_error usage_limit'],
      ['plan_limit', { log: 'working\nYou have hit your usage limit for today.' }, 'You have hit your usage limit for today.'],
      ['held', { launchNote: 'HELD: lane paused by owner\nmore' }, 'HELD: lane paused by owner'],
      ['precheck_skip', { events: [ev('RQ-WIDGET7', { event: 'precheck_skip', code: 'open_pr' })], log: null }, 'precheck_skip code open_pr'],
      ['publish_abort', { publish: 'pushing branch\nRESULT ABORT secret-shape\n' }, 'RESULT ABORT secret-shape'],
      ['already_done', { log: 'checked master\nThe change is already on main, nothing to do.' }, 'The change is already on main, nothing to do.'],
      ['blocked', { log: 'running lint\nbash: gh: command not found' }, 'bash: gh: command not found'],
      ['no_output', { log: null }, 'no log'],
      ['no_output', { log: '\n\n' }, 'log is empty'],
      ['no_output', { events: finishWith({ exit_code: 143 }), log: 'step two of five' }, 'log ends mid-run (exit 143)'],
      ['unknown', {}, 'all done here'],
    ];
    for (const [reason, over, evidence] of cases) expect(classifyEmptyRun(input(over)), reason).toMatchObject({ reason, evidence });
    expect(classifyEmptyRun(input())).toEqual({ job: 'RQ-WIDGET7', lane: 'claude', tier: 'frontier', family: 'RQ-WIDGE*', reason: 'unknown', evidence: 'all done here', tokens_total: 1000 });
    // Earlier reasons win: a limit beats a hold, a publish abort beats "already done".
    expect(classifyEmptyRun(input({ events: finishWith({ pool_error: 'quota' }), launchNote: 'HELD: paused' })).reason).toBe('plan_limit');
    expect(classifyEmptyRun(input({ publish: 'RESULT ABORT no-wt', log: 'already merged into main' })).reason).toBe('publish_abort');
    expect(classifyEmptyRun(input({ publish: 'RESULT ABORT no-wt\nRESULT PR opened' })).reason).toBe('unknown');
  });

  it('reads only the final log lines, keeps missing tokens unknown and scrubs evidence', () => {
    const echo = ['Task: stop if the work is already on main', ...Array.from({ length: 50 }, (_, i) => `step ${i}`)].join('\n');
    expect(classifyEmptyRun(input({ log: echo }))).toMatchObject({ reason: 'unknown', evidence: 'step 49' });
    expect(classifyEmptyRun(input({ events: finishWith({}) })).tokens_total).toBeNull();
    expect(classifyEmptyRun(input({ events: [] }))).toMatchObject({ lane: 'unknown', tier: 'unknown', tokens_total: null });
    const long = classifyEmptyRun(input({ log: `stopped in /Users/someone/work ${'word '.repeat(80)}` })).evidence!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).not.toContain('/Users/someone');
  });

  it('rolls up counts and tokens by reason, lane and family with the 10 costliest runs', () => {
    const runs = Array.from({ length: 12 }, (_, i) => classifyEmptyRun(input({
      job: `RQ-GADGET${i}`, events: [ev(`RQ-GADGET${i}`, { event: 'finish', empty: true, lane: i % 2 ? 'codex' : 'claude', ...(i === 11 ? {} : { tokens_total: (i + 1) * 100 }) })],
      log: i < 4 ? 'already merged into main' : null,
    })));
    const report = rollupEmptyRuns(runs, 24);
    expect(report).toMatchObject({ known: true, empties: 12, tokens_total: 6600, tokens_unknown_jobs: 1 });
    expect(report.by_reason.map(r => r.name)).toEqual([...EMPTY_RUN_REASONS]);
    expect(report.by_reason.find(r => r.name === 'already_done')).toEqual({ name: 'already_done', jobs: 4, tokens_total: 1000, tokens_unknown_jobs: 0 });
    expect(report.by_reason.find(r => r.name === 'no_output')).toEqual({ name: 'no_output', jobs: 8, tokens_total: 5600, tokens_unknown_jobs: 1 });
    expect(report.by_lane).toEqual([{ name: 'claude', jobs: 6, tokens_total: 3600, tokens_unknown_jobs: 0 }, { name: 'codex', jobs: 6, tokens_total: 3000, tokens_unknown_jobs: 1 }]);
    expect(report.by_family).toEqual([{ name: 'RQ-GADGE*', jobs: 12, tokens_total: 6600, tokens_unknown_jobs: 1 }]);
    expect(report.costliest.map(r => r.job)).toEqual(['RQ-GADGET10', 'RQ-GADGET9', 'RQ-GADGET8', 'RQ-GADGET7', 'RQ-GADGET6', 'RQ-GADGET5', 'RQ-GADGET4', 'RQ-GADGET3', 'RQ-GADGET2', 'RQ-GADGET1']);
    const unknownOnly = rollupEmptyRuns([classifyEmptyRun(input({ events: finishWith({}) }))], 24);
    expect(unknownOnly).toMatchObject({ tokens_total: null, tokens_unknown_jobs: 1, costliest: [] });
    expect(emptiesWhyText(unknownOnly)[0]).toContain('tokens unknown');
  });

  it('reads the runs folder: newest empty finish per job, empty window and unreadable metrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'empties-why-')); roots.push(root); await mkdir(join(root, 'metrics'));
    const rows = [
      ev('RQ-HELDJOB1', { event: 'launch', tier: 'cheap' }, 300), ev('RQ-HELDJOB1', { event: 'finish', empty: true, tokens_total: 55000 }),
      ev('RQ-ABORTJOB1', { event: 'finish', empty: true, tokens_total: 90000 }),
      ev('RQ-SKIPJOB1', { event: 'precheck_skip', code: 'dup' }),
      ev('RQ-NOLOGJOB1', { event: 'finish', empty: true }),
      ev('RQ-GOODJOB1', { event: 'finish', empty: true, tokens_total: 5 }, 200), ev('RQ-GOODJOB1', { event: 'finish', empty: false, tokens_total: 9 }),
      ev('RQ-OLDJOB1', { event: 'finish', empty: true, tokens_total: 1 }, 90_000),
    ];
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
    await writeFile(join(root, 'RQ-HELDJOB1.launch'), 'HELD: lane paused\n');
    await writeFile(join(root, 'RQ-HELDJOB1.log'), 'working\n');
    await writeFile(join(root, 'RQ-ABORTJOB1.publish'), 'RESULT ABORT repo-mismatch\n');
    await writeFile(join(root, 'RQ-ABORTJOB1.log'), 'made a change\n');
    const report = await readEmptiesWhy({ hours: 24, now, runsDir: root });
    expect(report.runs.map(r => [r.job, r.reason, r.tokens_total])).toEqual([
      ['RQ-ABORTJOB1', 'publish_abort', 90000], ['RQ-HELDJOB1', 'held', 55000], ['RQ-NOLOGJOB1', 'no_output', null], ['RQ-SKIPJOB1', 'precheck_skip', null],
    ]);
    expect(report.runs.find(r => r.job === 'RQ-HELDJOB1')?.tier).toBe('cheap');
    expect(report.costliest.map(r => r.job)).toEqual(['RQ-ABORTJOB1', 'RQ-HELDJOB1']);
    expect(JSON.stringify(report)).not.toContain(root);
    const quiet = await readEmptiesWhy({ hours: 1, now: now + 86_400_000, runsDir: root });
    expect(quiet).toMatchObject({ known: true, empties: 0, tokens_total: null, tokens_unknown_jobs: 0, by_lane: [], by_family: [], costliest: [], runs: [] });
    expect(quiet.by_reason.every(r => r.jobs === 0)).toBe(true);
    expect(emptiesWhyText(quiet)).toEqual(['Why runs ended empty (last 1 h): no empty runs.']);
    const missing = await readEmptiesWhy({ hours: 24, now, runsDir: join(root, 'absent') });
    expect(missing).toMatchObject({ known: false, empties: null, tokens_total: null, runs: [] });
  });

  it('CLI: --hours, JSON why shape and plain lines', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), 'empties-why-cli-')); roots.push(root); await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), [ev('RQ-CLIJOB1', { event: 'finish', empty: true, tokens_total: 70000, pool_error: 'rate_limit' }), ev('RQ-CLIJOB2', { event: 'finish', empty: true })].map(r => JSON.stringify(r)).join('\n'));
    for (const args of [['--hours'], ['--hours', '0'], ['--hours', '24h'], ['--hours', '2161'], ['--hours', '2', '--since', '2h']]) expect(await cmdFleetEmpties(args, undefined, now)).toBe(2);
    expect(await cmdFleetEmpties(['--runs-dir', root, '--hours', '24', '--json'], undefined, now)).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(out.schema).toBe('fleet.empties.v2');
    expect(Object.keys(out.why)).toEqual(['schema', 'hours', 'known', 'empties', 'tokens_total', 'tokens_unknown_jobs', 'by_reason', 'by_lane', 'by_family', 'costliest', 'runs']);
    expect(out.why).toMatchObject({ schema: 'fleet.empties.why.v1', hours: 24, known: true, empties: 2, tokens_total: 70000, tokens_unknown_jobs: 1 });
    expect(Object.keys(out.why.runs[0])).toEqual(['job', 'lane', 'tier', 'family', 'reason', 'evidence', 'tokens_total']);
    expect(out.why.runs).toMatchObject([{ job: 'RQ-CLIJOB1', reason: 'plan_limit', evidence: 'pool_error rate_limit' }, { job: 'RQ-CLIJOB2', reason: 'no_output', tokens_total: null }]);
    expect(await cmdFleetEmpties(['--runs-dir', root, '--hours', '24', '--human'], undefined, now)).toBe(0);
    const text = log.mock.calls.at(-1)![0] as string;
    expect(text).toContain('Why runs ended empty (last 24 h): 2 runs, 70,000 tokens (1 unknown).');
    expect(text).toContain('RQ-CLIJOB1 (claude): 70,000 tokens, plan limit: "pool_error rate_limit"');
  });

  it('serves the same report at GET /api/fleet/empties', async () => {
    const root = await mkdtemp(join(tmpdir(), 'empties-why-api-')); roots.push(root); await mkdir(join(root, 'metrics'));
    // The API server reads the real clock, so this row must be stamped relative to it
    // (the shared `ev` helper uses the suite's fixed `now`, which drifts out of the window).
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), JSON.stringify({ ...ev('RQ-APIJOB1', { event: 'finish', empty: true, tokens_total: 3 }, 60), ts: new Date(Date.now() - 60_000).toISOString() }));
    await writeFile(join(root, 'RQ-APIJOB1.log'), 'work is already on main\n');
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    try {
      const get = (query: string) => fetch(`${h.url}/api/fleet/empties${query}`, { headers: readAuthHeaders(h.port) });
      const ok = await get('?hours=48');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ schema: 'fleet.empties.why.v1', hours: 48, empties: 1, runs: [{ job: 'RQ-APIJOB1', reason: 'already_done' }] });
      expect((await get('?hours=0')).status).toBe(400);
      expect((await get('?hours=abc')).status).toBe(400);
      vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'absent'));
      expect((await get('')).status).toBe(503);
    } finally { vi.unstubAllEnvs(); await h.close(); }
  });
});
