/* global structuredClone */
// Port of .github/tests/ci-realio-worker-shadow.test.mjs (PR #674) to the
// vitest unit lane. The runner moved to scripts/realio-worker-shadow.mjs; the
// dispatch workflow is the inert template scripts/realio-worker-shadow.workflow.yml.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { MODULES, armArgs, phaseTimings, projectReport, runShadow } from '../scripts/realio-worker-shadow.mjs';
import { normalizeReport } from '../.github/scripts/ci-qualification-lane.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function report(root: string, overlap = false, failed = false) {
  const raw = { success: !failed, numTotalTests: 4, numPassedTests: failed ? 3 : 4, numFailedTests: Number(failed), numPendingTests: 0, numTodoTests: 0,
    numFailedTestSuites: Number(failed), testResults: MODULES.map((file, moduleId) => ({ name: join(root, file), status: failed && moduleId === 0 ? 'failed' : 'passed',
      startTime: 1000 + (moduleId === 1 ? (overlap ? 10 : 100) : 0), endTime: 1050 + (moduleId === 1 ? (overlap ? 10 : 100) : 0),
      assertionResults: [0, 1].map((i) => ({ fullName: 'same parameterized title', duration: 10 + i, status: failed && moduleId === 0 && i === 0 ? 'failed' : 'passed', failureMessages: failed ? ['SECRET /private/credential'] : [] })) })) };
  const expected = MODULES.map((file, moduleId) => ({ moduleId, ids: [0, 1].map((i) => hash(`${file}\0same parameterized title\0${i}`)).sort() }));
  return { raw, expected };
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-worker-shadow-test-'))); chmodSync(parent, 0o700);
  roots.push(parent);
  const root = parent;
  mkdirSync(join(root, 'test'));
  MODULES.forEach((file, i) => writeFileSync(join(root, file), `source module ${i}\n`, { mode: 0o600 }));
  const { expected } = report(root);
  const source = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), eventSha: 'a'.repeat(40) };
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'ashlrai/phantom', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', ASHLR_CANDIDATE_SHA: source.revision, GITHUB_SHA: source.eventSha,
    ASHLR_VITEST_TEST_TIMEOUT_MS: '1', ASHLR_TEST_CI_TIMEOUT_MS: '1', ASHLR_TEST_CI_WEIGHTED_PARTITION: '1', ASHLR_TEST_CI_REPORT_DIRECTORY: 'do-not-inherit', GITHUB_OUTPUT: join(parent, 'outputs') };
  let clock = 0;
  return { root, parent, env, expected, bind: () => source, now: () => (clock += 100), source };
}
function runner(f: ReturnType<typeof fixture>, mutate: (ctx: any) => any = () => undefined) {
  const calls: { command: string; args: string[]; options: any }[] = [];
  const run = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    const workers = Number(args.find((arg) => arg.startsWith('--maxWorkers='))!.split('=')[1]);
    const path = args.find((arg) => arg.startsWith('--outputFile.json='))!.slice('--outputFile.json='.length);
    expect(args).toEqual(armArgs(workers, path)); expect(command).toBe('npm'); expect(options.cwd).toBe(f.root);
    expect(options.stdio[0]).toBe('ignore'); expect(options.stdio[1]).toBe(options.stdio[2]);
    for (const key of ['ASHLR_VITEST_TEST_TIMEOUT_MS', 'ASHLR_TEST_CI_TIMEOUT_MS', 'ASHLR_TEST_CI_WEIGHTED_PARTITION', 'ASHLR_TEST_CI_REPORT_DIRECTORY']) expect(Object.hasOwn(options.env, key)).toBe(false);
    const raw = report(f.root, workers === 2).raw;
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    writeFileSync(options.stdio[1], 'SECRET console path\n Duration 0.1s (transform 20ms, setup 0.01s, import 15ms, tests 40ms, environment 0ms)\n');
    return mutate({ path, raw, workers, options }) ?? { status: 0, signal: null };
  };
  return { run, calls };
}
function readReceipt(result: { directory: string }) { return JSON.parse(readFileSync(join(result.directory, 'measurements.json'), 'utf8')); }
function assertNumericOnly(value: any): void {
  if (value === null || typeof value === 'number') { expect(value === null || Number.isFinite(value)).toBeTruthy(); return; }
  if (typeof value === 'string') { expect(value).toMatch(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/); return; }
  if (Array.isArray(value)) { value.forEach(assertNumericOnly); return; }
  expect(typeof value).toBe('object'); Object.values(value).forEach(assertNumericOnly);
}

describe('real-I/O worker shadow experiment', () => {
  it('fixed inventory has exactly 82 distinct opaque cases in the two whole modules', () => {
    const inventory = JSON.parse(readFileSync(new URL('../scripts/realio-worker-shadow-cases.json', import.meta.url), 'utf8'));
    expect(inventory.map((m: any) => [m.moduleId, m.ids.length])).toEqual([[0, 22], [1, 60]]);
    const ids = inventory.flatMap((m: any) => m.ids); expect(new Set(ids).size).toBe(82);
    ids.forEach((id: string) => expect(id).toMatch(/^[a-f0-9]{64}$/));
  });
  it('projection agrees with existing occurrence-aware normalizer and measures observed overlap', () => {
    const { raw, expected } = report('/source');
    const projected = projectReport(raw, '/source', expected);
    const normalized = normalizeReport(raw, '/source');
    expect(projected.modules.map((m: any) => m.cases.map((c: any) => c.id))).toEqual(normalized.map((m: any) => m.cases.map((c: any) => c.id).sort()));
    expect(projected.pass).toBe(1); expect(projected.overlapObserved).toBe(0);
    expect(projectReport(report('/source', true).raw, '/source', expected).overlapObserved).toBe(1);
    assertNumericOnly(projected);
  });
  it('failed reports retain identities and failure states without secret failure messages', () => {
    const { raw, expected } = report('/source', true, true);
    const projected = projectReport(raw, '/source', expected);
    expect(projected.pass).toBe(0); expect(projected.complete).toBe(1); expect(projected.totals).toEqual([3, 1, 0, 0, 0]);
    assertNumericOnly(projected); expect(JSON.stringify(projected).includes('SECRET')).toBe(false);
  });
  it('unfinished pending cases retain a separate numeric state and never count as passed', () => {
    const { raw, expected } = report('/source', false, true);
    raw.testResults[0]!.assertionResults[1]!.status = 'pending'; raw.numPassedTests = 2; raw.numPendingTests = 1;
    const projected = projectReport(raw, '/source', expected);
    expect(projected.totals).toEqual([2, 1, 0, 0, 1]); expect(projected.pass).toBe(0);
    expect(projected.modules[0].cases.some((c: any) => c.state === 4)).toBe(true);
  });
  it('Vitest success true with 81 passing and 1 pending case retains all 82 states and stops before arm two', () => {
    const f = fixture(); const raw = report(f.root).raw as any;
    raw.testResults.forEach((module: any, moduleId: number) => {
      module.assertionResults = Array.from({ length: moduleId === 0 ? 22 : 60 }, (_, i) => ({ fullName: `module ${moduleId} case ${i}`, status: 'passed', duration: 10, failureMessages: [] }));
    });
    raw.numTotalTests = raw.numPassedTests = 82;
    const expected = MODULES.map((file, moduleId) => ({ moduleId, ids: raw.testResults[moduleId].assertionResults.map((item: any) => hash(`${file}\0${item.fullName}\0${0}`)).sort() }));
    const terminal = projectReport(raw, f.root, expected);
    raw.testResults[0].assertionResults[0].status = 'pending';
    delete raw.testResults[0].assertionResults[0].duration;
    raw.numPassedTests = 81; raw.numPendingTests = 1;
    const projected = projectReport(raw, f.root, expected);
    expect(projected.complete).toBe(1); expect(projected.pass).toBe(0);
    expect(projected.totals).toEqual([81, 0, 0, 0, 1]);
    expect(projected.modules.map((m: any) => m.cases.map((c: any) => c.id))).toEqual(terminal.modules.map((m: any) => m.cases.map((c: any) => c.id)));
    expect(projected.modules.every((m: any) => m.state === 0)).toBe(true);
    expect(projected.modules.flatMap((m: any) => m.cases).filter((c: any) => c.state === 4).length).toBe(1);
    assertNumericOnly(projected);
    const r = runner(f, ({ path }) => { writeFileSync(path, JSON.stringify(raw), { mode: 0o600 }); return { status: 0, signal: null }; });
    const result = runShadow({ ...f, expected, run: r.run }); const receipt = readReceipt(result);
    expect(result.pass).toBe(false); expect(r.calls.length).toBe(1); expect(receipt.arms[0].reportState).toBe(1);
    expect(receipt.arms[0].report.modules).toEqual(projected.modules); assertNumericOnly(receipt);
    for (const mutate of [(r2: any) => { r2.numPendingTests = 0; }, (r2: any) => { r2.testResults[0].assertionResults[0].status = 'unknown'; }, (r2: any) => { r2.success = false; r2.numPendingTests = 0; r2.numPassedTests = 81; r2.numFailedTests = 1; r2.testResults[0].assertionResults[0].status = 'failed'; }]) {
      const invalid = structuredClone(raw); mutate(invalid); expect(() => projectReport(invalid, f.root, expected)).toThrow();
    }
  });
  it('unknown cases, missing modules and skipped cases never become a successful pair', () => {
    const { raw, expected } = report('/source');
    raw.testResults[0]!.assertionResults[0]!.fullName = 'changed';
    expect(projectReport(raw, '/source', expected).pass).toBe(0);
    const missing = report('/source'); missing.raw.testResults.pop(); missing.raw.numTotalTests = missing.raw.numPassedTests = 2;
    expect(projectReport(missing.raw, '/source', missing.expected).complete).toBe(0);
    const skipped = report('/source'); skipped.raw.testResults[0]!.assertionResults[0]!.status = 'skipped'; skipped.raw.numPassedTests = 3; skipped.raw.numPendingTests = 1;
    expect(projectReport(skipped.raw, '/source', skipped.expected).pass).toBe(0);
  });
  it('unsafe report identity, counts and non-finite durations are refused', () => {
    for (const mutate of [(r: any) => { r.numTotalTests++; }, (r: any) => { r.testResults[0].name = '/elsewhere/test.ts'; }, (r: any) => { r.testResults[1].name = r.testResults[0].name; }, (r: any) => { r.testResults[0].endTime = Infinity; }, (r: any) => { r.testResults[0].assertionResults[0].duration = -1; }]) {
      const { raw, expected } = report('/source'); mutate(raw); expect(() => projectReport(raw, '/source', expected)).toThrow();
    }
  });
  it('phase timings publish scalars only and leave unavailable phases null', () => {
    expect(phaseTimings('SECRET\n Duration 2s (transform 1.2s, setup 12ms, import 3ms, tests 2s, environment 0ms)')).toEqual({ transformMs: 1200, setupMs: 12, importMs: 3, testsMs: 2000, environmentMs: 0 });
    expect(phaseTimings('no summary')).toEqual({ transformMs: null, setupMs: null, importMs: null, testsMs: null, environmentMs: null });
    expect(phaseTimings(` Duration 2s (transform ${'9'.repeat(400)}s)`).transformMs).toBe(null);
  });
  it('one sequential pair uses existing wrapper boundaries and uploads only projected evidence', () => {
    const f = fixture(); const r = runner(f); const result = runShadow({ ...f, run: r.run });
    expect(result.pass).toBe(true); expect(r.calls.length).toBe(2);
    expect(r.calls[0]!.args.at(-1)).not.toBe(r.calls[1]!.args.at(-1));
    const receipt = readReceipt(result); assertNumericOnly(receipt);
    expect(receipt.arms.map((a: any) => [a.workers, a.report.overlapObserved, a.status])).toEqual([[1, 0, 0], [2, 1, 0]]);
    expect(readdirSync(result.directory)).toEqual(['measurements.json']); expect(lstatSync(result.directory).mode & 0o777).toBe(0o700);
    expect(receipt.qualification).toBe(0); expect(receipt.resultReuse).toBe(0);
    expect(receipt.moduleContentHashes).toEqual(MODULES.map((_file, moduleId) => ({ moduleId, sha256: hash(`source module ${moduleId}\n`) })));
    for (const arm of receipt.arms) for (const sample of [arm.hostBefore, arm.hostAfter]) {
      expect(sample.loadAverage.length).toBe(3); expect(sample.freeMemoryBytes >= 0).toBeTruthy(); sample.loadAverage.forEach((value: number) => expect(value >= 0).toBeTruthy());
    }
    expect(readFileSync(join(f.parent, 'outputs'), 'utf8')).toBe(`numeric_dir=${result.directory}\n`);
  });
  it('first failure is preserved and prevents retries, fallback or a second arm', () => {
    const f = fixture(); const r = runner(f, ({ path }) => { writeFileSync(path, JSON.stringify(report(f.root, false, true).raw), { mode: 0o600 }); return { status: 1, signal: null }; });
    const result = runShadow({ ...f, run: r.run }); const receipt = readReceipt(result);
    expect(result.pass).toBe(false); expect(r.calls.length).toBe(1); expect(receipt.arms[0].report.totals[1]).toBe(1); expect(receipt.arms[0].exitCode).toBe(1); assertNumericOnly(receipt);
  });
  it('collection failure retains surviving case evidence and stops before arm two', () => {
    const f = fixture();
    const surviving = report(f.root).raw.testResults[1];
    const failure = report(f.root, false, true).raw as any;
    failure.testResults[0].assertionResults = [];
    failure.testResults[0].message = 'SECRET import failure /private/credential';
    failure.testResults[1] = surviving;
    failure.numTotalTests = failure.numPassedTests = 2;
    failure.numFailedTests = 0;
    const expectedSurvivors = projectReport(report(f.root).raw, f.root, f.expected).modules[1];
    const projected = projectReport(failure, f.root, f.expected);
    expect(projected.complete).toBe(0); expect(projected.pass).toBe(0);
    expect(projected.modules[0]).toEqual({ moduleId: 0, state: 1, durationMs: 50, startMs: 0, endMs: 50, exactInventory: 0, cases: [] });
    expect(projected.modules[1]).toEqual(expectedSurvivors);
    assertNumericOnly(projected); expect(JSON.stringify(projected).includes('SECRET')).toBe(false);
    const r = runner(f, ({ path }) => { writeFileSync(path, JSON.stringify(failure), { mode: 0o600 }); return { status: 1, signal: null }; });
    const result = runShadow({ ...f, run: r.run }); const receipt = readReceipt(result);
    expect(result.pass).toBe(false); expect(r.calls.length).toBe(1); expect(receipt.arms[0].reportState).toBe(1);
    expect(receipt.arms[0].report.modules).toEqual(projected.modules);
    assertNumericOnly(receipt);
    for (const success of [false, true]) {
      const empty = structuredClone(failure); empty.success = success; empty.testResults[0].status = 'passed';
      expect(() => projectReport(empty, f.root, f.expected)).toThrow();
    }
    const successfulEmpty = structuredClone(failure); successfulEmpty.success = true; successfulEmpty.numFailedTestSuites = 0;
    expect(() => projectReport(successfulEmpty, f.root, f.expected)).toThrow();
  });
  it('missing and symlink reports are numeric refusals with no second attempt', () => {
    for (const symlink of [false, true]) {
      const f = fixture(); const r = runner(f, ({ path }) => { rmSync(path); if (symlink) symlinkSync(join(f.parent, 'outputs'), path); return { status: 0, signal: null }; });
      const result = runShadow({ ...f, run: r.run }); expect(result.pass).toBe(false); expect(r.calls.length).toBe(1); expect(readReceipt(result).arms[0].reportState).toBe(2);
    }
  });
  it('thrown child error and source changes preserve first receipt without raw diagnostic', () => {
    for (const change of [false, true]) {
      const f = fixture(); const r = runner(f, () => { if (!change) throw new Error('SECRET credential'); });
      let binds = 0;
      const result = runShadow({ ...f, run: r.run, bind: () => { if (change && binds++ > 0) throw new Error('source changed'); return f.source; } });
      expect(result.pass).toBe(false); expect(r.calls.length).toBe(1); assertNumericOnly(readReceipt(result));
    }
  });
  it('non-manual or other-repository event cannot invoke any tests', () => {
    const f = fixture(); let called = false;
    for (const update of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_RUN_ID: '0' }]) {
      expect(() => runShadow({ ...f, env: { ...f.env, ...update }, run: () => { called = true; } })).toThrow();
    }
    expect(called).toBe(false);
  });
  it('manual workflow preserves immutable actions and avoids release or matrix authority', () => {
    const workflow = readFileSync(new URL('../scripts/realio-worker-shadow.workflow.yml', import.meta.url), 'utf8');
    const config = parse(workflow) as any;
    expect(config.on).toEqual({ workflow_dispatch: null }); expect(config.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(config.jobs)).toEqual(['measure']); expect(config.jobs.measure.steps.length).toBe(8);
    const events = workflow.split('on:\n')[1]!.split('\npermissions:')[0]; expect(events!.trim()).toBe('workflow_dispatch:');
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n/); expect(workflow).not.toMatch(/id-token:|secrets\.|workflow_call:|pull_request:|push:|strategy:|matrix:|continue-on-error|--retry|gh workflow/);
    expect(workflow).toMatch(/runs-on: macos-15/); expect(workflow).toMatch(/node-version: "22\.22\.3"/);
    expect((workflow.match(/npm run build/g) ?? []).length).toBe(1); expect((workflow.match(/npm ci/g) ?? []).length).toBe(1);
    expect(workflow).toMatch(/cancel-in-progress: false/); expect(workflow).toMatch(/outputs\.numeric_dir }}\/measurements\.json/);
    const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
    expect(actions).toEqual(['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a']);
    // The template stays inert under scripts/: it must invoke the ported runner.
    expect(workflow).toContain('run: node scripts/realio-worker-shadow.mjs');
    const wrapper = readFileSync(new URL('../scripts/test-ci.mjs', import.meta.url), 'utf8');
    expect(wrapper).toMatch(/mkdtempSync\(join\(tmpdir\(\), 'ashlr-test-ci-home-'\)\)/); expect(wrapper).toMatch(/HOME: home/);
    expect(() => armArgs(3, '/report')).toThrow();
  });
});
