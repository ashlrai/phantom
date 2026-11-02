import { describe, expect, it } from 'vitest';
import { parseVitestReport } from '../scripts/test-fast-report.mjs';

describe('fast test duration report', () => {
  it('sorts file durations and flags only files over the budget', () => {
    const report = parseVitestReport({ testResults: [
      { name: '/repo/test/b.test.ts', startTime: 100, endTime: 20100, status: 'passed' },
      { name: '/repo/test/a.test.ts', startTime: 0, endTime: 20001, status: 'failed' },
      { name: 'test/c.test.ts', startTime: 2, endTime: 2, status: 'skipped' },
    ] }, '/repo');
    expect(report.budgetMs).toBe(20_000);
    expect(report.files.map((file: { file: string }) => file.file)).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts']);
    expect(report.files[0]).toMatchObject({ durationMs: 20001, status: 'failed', overBudget: true, suggestion: expect.stringContaining('Split') });
    expect(report.files[1].overBudget).toBe(false);
    expect(report.files[2].durationMs).toBe(0);
  });

  it('rejects missing or invalid timings rather than reporting misleading results', () => {
    expect(() => parseVitestReport({}, '/repo')).toThrow('testResults');
    for (const result of [
      { name: 'test/a', startTime: 2 },
      { name: 'test/a', startTime: 2, endTime: 1 },
      { name: '', startTime: 0, endTime: 1 },
    ]) {
      expect(() => parseVitestReport({ testResults: [result] }, '/repo')).toThrow('valid timing');
    }
    expect(parseVitestReport({ testResults: [] }, '/repo').files).toEqual([]);
  });
});
