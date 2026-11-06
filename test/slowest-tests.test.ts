import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/slowest-tests.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/slowest-tests/results.json', import.meta.url));
const run = (input: unknown) => execFileSync(process.execPath, [script, '-'], {
  input: JSON.stringify(input), encoding: 'utf8',
});

describe('slowest tests report', () => {
  it('ranks fixture files and cases independently, including failures and zero durations', () => {
    const output = execFileSync(process.execPath, [script, fixture], { encoding: 'utf8' });
    expect(output).toBe(`15 slowest files (elapsed time)
1. 200.00 ms  slow.test.ts
2. 10.00 ms  fast.test.ts
Omitted without valid timing: 1

15 slowest cases
1. 99.50 ms  slow.test.ts > group failed
2. 1.25 ms  fast.test.ts > group fast
3. 1.25 ms  slow.test.ts > group tie
4. 0.00 ms  fast.test.ts > group zero
Omitted without valid timing: 2
`);
    expect(run(JSON.parse(readFileSync(fixture, 'utf8')))).toBe(output);
  });

  it('limits each ranking to 15, sorted numerically rather than by input order', () => {
    const testResults = Array.from({ length: 20 }, (_, i) => ({
      name: `file-${i}`, startTime: 0, endTime: i,
      assertionResults: [{ fullName: `case-${i}`, duration: 20 - i }],
    }));
    const [files, cases] = run({ testResults }).split('\n\n');
    expect(files).toContain('1. 19.00 ms  file-19');
    expect(files).toContain('15. 5.00 ms  file-5');
    expect(cases).toContain('1. 20.00 ms  file-0 > case-0');
    expect(cases).toContain('15. 6.00 ms  file-14 > case-14');
    expect(files).not.toMatch(/^16\./m);
    expect(cases).not.toMatch(/^16\./m);
  });

  it('handles empty reports and omits invalid timings without inventing durations', () => {
    expect(run({ testResults: [] })).toContain('(no measured results)');
    const output = run({ testResults: [{ name: 'file', startTime: 9, endTime: 1,
      assertionResults: [{ fullName: 'negative', duration: -1 }, { fullName: 'string', duration: '5' }] }] });
    expect(output).toContain('Omitted without valid timing: 1');
    expect(output).toContain('Omitted without valid timing: 2');
    expect(output).not.toContain(' ms ');
  });

  it('keeps labels on one line and orders ties consistently', () => {
    const output = run({ testResults: ['z', 'a\n'].map(name => ({ name,
      startTime: 0, endTime: 1, assertionResults: [{ fullName: 'case\tname', duration: 1 }] })) });
    expect(output).toContain('1. 1.00 ms  a ');
    expect(output).toContain('a  > case name');
  });

  it('rejects unreadable, malformed and non-Vitest input with no partial report', () => {
    for (const [args, input] of [
      [[], ''], [['missing-report.json'], ''], [['--unknown'], ''],
      [['-', 'extra'], ''], [['-'], '{private input'], [['-'], '{}'],
      [['-'], '{"testResults":[null]}'],
      [['-'], '{"testResults":[{"name":"x","assertionResults":[null]}]}'],
    ] as [string[], string][]) {
      const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('slowest-tests:');
      expect(result.stderr).not.toContain('private input');
    }
  });

  it('provides usage help', () => {
    expect(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })).toContain('Usage:');
  });
});
