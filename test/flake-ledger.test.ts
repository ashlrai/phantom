import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFlakeLedger, main } from '../scripts/flake-ledger.mjs';

const sha = 'a'.repeat(40);
const root = '/home/runner/work/phantom/phantom';
const privateError = 'PRIVATE_ASSERTION_ERROR_DO_NOT_EXPORT';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
type Case = { fullName: string; status: string; failureMessages: string[] };
const testCase = (status = 'passed', fullName = 'suite example', errors: string[] = []): Case => ({ fullName, status, failureMessages: errors });
function report(cases = [testCase()], name = `${root}/test/example.test.ts`, hookFailure = false) {
  const count = (status: string) => cases.filter((item) => item.status === status).length;
  const failed = count('failed') > 0 || hookFailure;
  return { success: !failed, numFailedTestSuites: failed ? 1 : 0,
    numTotalTests: cases.length, numPassedTests: count('passed'), numFailedTests: count('failed'),
    numPendingTests: count('skipped') + count('pending') + count('disabled'), numTodoTests: count('todo'),
    testResults: [{ name, status: failed ? 'failed' : 'passed', message: privateError, assertionResults: cases }] };
}
function run(id = '10', overrides: Record<string, unknown> = {}) {
  return { id, attempt: 1, headSha: sha, workflow: 'CI', job: 'Tests (ubuntu)', project: 'unit',
    completedAt: '2026-10-26T12:00:00.000Z', conclusion: 'success', sourceRoot: root,
    reports: [`${id}.json`], ...overrides };
}
function history(runs = [run()]) {
  return { schema: 'phantom-flake-history/v1', repository: 'ashlrai/phantom', runs };
}
const pass = encode(report());
const fail = encode(report([testCase('failed', undefined, [privateError])]));
function ledger(runs = [run()], reports: Record<string, Uint8Array> = { '10.json': pass }) {
  return buildFlakeLedger(history(runs), (path: string) => {
    if (!(path in reports)) throw new Error(privateError);
    return reports[path];
  });
}
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('CI-history per-test flake ledger', () => {
  it('suggests advisory labels for same-revision fail/pass reruns with exact provenance', () => {
    const result = ledger([run('10', { conclusion: 'failure' }), run('10', { attempt: 2, reports: ['retry.json'] })],
      { '10.json': fail, 'retry.json': pass });
    expect(result.summary).toEqual({ runJobs: 2, missingReportRunJobs: 0, tests: 1, flakyTests: 1, ambiguousTests: 0 });
    const entry = result.tests[0];
    expect(entry).toMatchObject({ file: 'test/example.test.ts', name: 'suite example', classification: 'flaky',
      counts: { failed: 1, passed: 1, retriedPasses: 0 }, executions: 2, finalFailureRate: 0.5 });
    expect(entry.observations.map((item: { attempt: number }) => item.attempt)).toEqual([1, 2]);
    expect(entry.observations[0].reportSha256).toBe(createHash('sha256').update(fail).digest('hex'));
    expect(entry.evidence).toEqual([{ kind: 'same-revision-fail-pass', revisions: [sha] }]);
    expect(result.suggestions).toEqual([{ testId: entry.id, label: 'ci:quarantine-candidate', applied: false, evidence: entry.evidence }]);
    expect(result).toMatchObject({ advisoryOnly: true, requiredChecks: 'unchanged', provenance: 'caller-supplied-not-authenticated' });
    expect(JSON.stringify(result)).not.toContain(privateError);
  });

  it('detects mixed outcomes on separate CI runs of the same revision', () => {
    expect(ledger([run('10'), run('11')], { '10.json': fail, '11.json': pass }).tests[0].classification).toBe('flaky');
  });

  it('recognizes successful retries retaining earlier errors without exporting the errors', () => {
    const result = ledger([run()], { '10.json': encode(report([testCase('passed', undefined, [privateError])])) });
    expect(result.tests[0]).toMatchObject({ classification: 'flaky', counts: { passed: 1, failed: 0, retriedPasses: 1 }, finalFailureRate: 0 });
    expect(result.tests[0].evidence).toEqual([{ kind: 'passed-with-retry-errors', count: 1 }]);
    expect(JSON.stringify(result)).not.toContain(privateError);
  });

  it('keeps regressions across commits inconclusive', () => {
    const result = ledger([run('10'), run('11', { headSha: 'b'.repeat(40) })], { '10.json': pass, '11.json': fail });
    expect(result.tests[0].classification).toBe('mixed-unconfirmed');
    expect(result.suggestions).toEqual([]);
  });

  it.each(['workflow', 'job', 'project'])('separates %s so different configurations cannot manufacture flakes', (field) => {
    const result = ledger([run('10'), run('11', { [field]: 'different' })], { '10.json': pass, '11.json': fail });
    expect(result.tests.map((item: { classification: string }) => item.classification).sort()).toEqual(['consistent-fail', 'consistent-pass']);
    expect(result.suggestions).toEqual([]);
  });

  it('retains identical titles in different files as separate tests', () => {
    const raw = report();
    raw.testResults.push(report([testCase('failed')], `${root}/test/other.test.ts`).testResults[0]);
    Object.assign(raw, { success: false, numFailedTestSuites: 1, numTotalTests: 2, numFailedTests: 1 });
    expect(ledger([run()], { '10.json': encode(raw) }).tests).toHaveLength(2);
  });

  it('preserves multiline and control characters in legitimate titles as escaped JSON data', () => {
    const title = 'round-trips\nline\twith\0control characters';
    const result = ledger([run()], { '10.json': encode(report([testCase('passed', title)])) });
    expect(result.tests[0].name).toBe(title);
    expect(JSON.stringify(result)).toContain('round-trips\\nline\\twith\\u0000control characters');
  });

  it('preserves duplicate title occurrences and suppresses ambiguous labels even across filtered captures', () => {
    const duplicate = encode(report([testCase('failed'), testCase('passed')]));
    const result = ledger([run('10'), run('11')], { '10.json': duplicate, '11.json': pass });
    expect(result.tests).toHaveLength(2);
    expect(result.tests.map((item: { occurrence: number }) => item.occurrence).sort()).toEqual([0, 1]);
    expect(result.tests.every((item: { classification: string }) => item.classification === 'ambiguous')).toBe(true);
    expect(result.suggestions).toEqual([]);
  });

  it('does not count skipped, pending, disabled or todo cases as executed or passed', () => {
    const cases = ['skipped', 'pending', 'disabled', 'todo'].map((state) => testCase(state, state));
    const result = ledger([run()], { '10.json': encode(report(cases)) });
    expect(result.tests.every((item: { executions: number; finalFailureRate: unknown; classification: string }) =>
      item.executions === 0 && item.finalFailureRate === null && item.classification === 'unexecuted')).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(result.tests.find((item: { name: string }) => item.name === 'pending').observations[0].reportedState).toBe('pending');
  });

  it('records cancelled/missing reports and absent cases as unknown without inventing observations', () => {
    const result = ledger([run('10'), run('11', { conclusion: 'cancelled', reports: [] })]);
    expect(result.summary.missingReportRunJobs).toBe(1);
    expect(result.runs.find((item: { id: string }) => item.id === '11').coverage).toBe('unobserved');
    expect(result.tests[0].observations).toHaveLength(1);
    expect(ledger([run('10', { reports: [] })], {}).tests).toEqual([]);
  });

  it('does not turn hook/module failures or job conclusions into per-case failures', () => {
    const result = ledger([run('10', { conclusion: 'failure' })], { '10.json': encode(report([testCase()], undefined, true)) });
    expect(result.runs[0].moduleFailures).toBe(1);
    expect(result.tests[0]).toMatchObject({ classification: 'consistent-pass', counts: { passed: 1, failed: 0 } });
    const empty = ledger([run()], { '10.json': encode(report([], undefined, true)) });
    expect(empty.runs[0].moduleFailures).toBe(1); expect(empty.tests).toEqual([]);
  });

  it('deduplicates exact run/job reimports and produces order-independent output', () => {
    const a = run('10'), b = run('11');
    const reports = { '10.json': pass, '11.json': fail };
    expect(ledger([a, b, a], reports)).toEqual(ledger([b, a], reports));
    expect(ledger([a, a]).tests[0].observations).toHaveLength(1);
  });

  it('rejects conflicting copies of a run/job and overlapping report modules', () => {
    expect(() => ledger([run(), run('10', { headSha: 'b'.repeat(40) })])).toThrow('Conflicting reimport');
    expect(() => ledger([run(), run('10', { sourceRoot: '/home/runner/work' })])).toThrow('Conflicting reimport');
    expect(() => ledger([run('10', { reports: ['10.json', 'copy.json'] })], { '10.json': pass, 'copy.json': pass })).toThrow('Overlapping test modules');
    expect(() => ledger([run('10', { reports: ['10.json', '10.json'] })])).toThrow('Duplicate report path');
  });

  it('normalizes Windows and POSIX CI checkout prefixes to the same case identity', () => {
    const windows = ledger([run('10', { sourceRoot: 'D:\\a\\phantom\\phantom' })], {
      '10.json': encode(report([testCase()], 'D:\\a\\phantom\\phantom\\test\\example.test.ts')),
    });
    expect(windows.tests[0].id).toBe(ledger().tests[0].id);
  });

  it.each(['../escape.test.ts', '/outside/test/example.test.ts', `${root}-other/test/example.test.ts`, 'D:\\elsewhere\\example.test.ts'])('rejects checkout escapes: %s', (path) => {
    expect(() => ledger([run()], { '10.json': encode(report([testCase()], path)) })).toThrow();
  });

  it.each(['../outside.json', '/absolute.json', 'D:\\absolute.json', 'a/../../outside.json', 'a//b.json', 'a/./b.json', 'https:report.json'])('rejects unsafe local report path: %s', (path) => {
    expect(() => ledger([run('10', { reports: [path] })])).toThrow('Invalid relative report path');
  });

  it.each([
    { id: 10 }, { attempt: 0 }, { attempt: 1.5 }, { headSha: 'short' }, { completedAt: 'yesterday' },
    { project: '' }, { job: '' }, { workflow: '' }, { conclusion: 'unknown' }, { sourceRoot: 'relative' },
  ])('rejects incomplete or invalid run metadata: %j', (patch) => {
    expect(() => ledger([run('10', patch)])).toThrow('Invalid CI run metadata');
  });

  it.each([
    { numTotalTests: 20 }, { numPassedTests: 0 }, { numFailedTestSuites: -1 }, { success: 'true' },
    { testResults: null }, { numPendingTests: 1 }, { numTodoTests: 1 },
  ])('rejects inconsistent or malformed reports: %j', (patch) => {
    expect(() => ledger([run()], { '10.json': encode({ ...report(), ...patch }) })).toThrow();
  });

  it('rejects unknown case states, missing failure metadata, invalid UTF-8 and truncated JSON', () => {
    for (const value of [report([testCase('unknown')]), report([{ ...testCase(), failureMessages: undefined } as unknown as Case])]) {
      expect(() => ledger([run()], { '10.json': encode(value) })).toThrow('Invalid Vitest case');
    }
    for (const bytes of [Buffer.from([0xff]), Buffer.from('{')]) {
      expect(() => ledger([run()], { '10.json': bytes })).toThrow('Invalid JSON report');
    }
  });

  it('bounds history records before reading reports', () => {
    expect(() => buildFlakeLedger(history(Array.from({ length: 1001 }, () => run())), () => { throw new Error('must not read'); })).toThrow('Invalid CI history manifest');
  });

  it('bounds report count and bytes before parsing', () => {
    expect(() => ledger([run('10', { reports: Array.from({ length: 5001 }, (_, index) => `${index}.json`) })])).toThrow('Too many reports');
    expect(() => ledger([run()], { '10.json': Buffer.alloc(64 * 1024 * 1024 + 1) })).toThrow('Report is too large');
  });

  it('represents empty history explicitly without claiming coverage', () => {
    expect(ledger([], {})).toMatchObject({ coverage: 'supplied-reports-only', tests: [], suggestions: [], summary: { runJobs: 0 } });
  });
});

describe('offline flake-ledger command', () => {
  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'phantom-flake-')); roots.push(directory);
    const manifest = join(directory, 'history.json');
    writeFileSync(manifest, encode(history())); writeFileSync(join(directory, '10.json'), fail);
    const stdout: string[] = [], stderr: string[] = [];
    const output = { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) };
    return { directory, manifest, stdout, stderr, output };
  }

  it('reads the manifest and reports end-to-end without changing failures or any input files', () => {
    const { directory, manifest, stdout, stderr, output } = fixture();
    const before = readFileSync(join(directory, '10.json'));
    expect(main([manifest], output)).toBe(0);
    expect(stderr).toEqual([]);
    const result = JSON.parse(stdout[0]);
    expect(result.tests[0].counts.failed).toBe(1);
    expect(result.tests[0].classification).toBe('consistent-fail');
    expect(result.requiredChecks).toBe('unchanged');
    expect(readFileSync(join(directory, '10.json'))).toEqual(before);
    expect(stdout[0]).not.toContain(privateError);
  });

  it('emits quarantine label suggestions from an explicit failed run and successful rerun through the CLI', () => {
    const { directory, manifest, stdout, output } = fixture();
    writeFileSync(join(directory, 'retry.json'), pass);
    writeFileSync(manifest, encode(history([run('10', { conclusion: 'failure' }), run('10', { attempt: 2, reports: ['retry.json'] })])));
    expect(main([manifest], output)).toBe(0);
    const result = JSON.parse(stdout[0]);
    expect(result.tests[0].classification).toBe('flaky');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ testId: result.tests[0].id, label: 'ci:quarantine-candidate', applied: false });
    expect(result.requiredChecks).toBe('unchanged');
  });

  it('emits no partial ledger and sanitized errors on malformed or missing reports', () => {
    const { directory, manifest, stdout, stderr, output } = fixture();
    writeFileSync(join(directory, '10.json'), `{ ${privateError}`);
    expect(main([manifest], output)).toBe(1);
    rmSync(join(directory, '10.json'));
    expect(main([manifest], output)).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join()).not.toContain(privateError);
    expect(stderr.join()).toContain('Required checks remain unchanged');
  });

  it('refuses report symlinks, symlinked parent directories and non-regular files', () => {
    const { directory, manifest, stdout, output } = fixture();
    const file = join(directory, '10.json');
    rmSync(file); symlinkSync(manifest, file);
    expect(main([manifest], output)).toBe(1);
    rmSync(file); mkdirSync(file);
    expect(main([manifest], output)).toBe(1);
    symlinkSync(directory, join(directory, 'alias'), 'dir');
    writeFileSync(manifest, encode(history([run('10', { reports: ['alias/history.json'] })])));
    expect(main([manifest], output)).toBe(1);
    expect(stdout).toEqual([]);
  });

  it('bounds manifest reads before parsing', () => {
    const { manifest, stdout, stderr, output } = fixture();
    writeFileSync(manifest, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(main([manifest], output)).toBe(1);
    expect(stdout).toEqual([]); expect(stderr[0]).toContain('bounded regular file');
  });

  it('documents the schema, evidence limits and advisory-only semantics in --help', () => {
    const { stdout, stderr, output } = fixture();
    expect(main(['--help'], output)).toBe(0);
    expect(stdout[0]).toContain('phantom-flake-history/v1');
    expect(stdout[0]).toContain('never permission to skip a required check');
    expect(main([], output)).toBe(1); expect(main(['--unknown'], output)).toBe(1);
    expect(stderr).toHaveLength(2);
  });
});
