import { describe, expect, it } from 'vitest';
import { generateTestSupply, type TestSupplyCase } from '../src/core/driver/test-supply.js';
import { restockTestQueue } from '../src/core/driver/restock.js';

const cases = (count: number, file = 'test/example.test.ts', repo = 'phantom'): TestSupplyCase[] =>
  Array.from({ length: count }, (_, index) => ({ repo, file, title: `Case ${index + 1}` }));
const plan = (candidates: TestSupplyCase[], extra: Partial<Parameters<typeof generateTestSupply>[0]> = {}) =>
  generateTestSupply({ candidates, existing: [], activeFiles: [], queue: '', ...extra });

describe('test supply queue planning', () => {
  it.each([4, 5, 6, 7, 8])('emits a single %i-case batch per file', count => {
    const lines = plan(cases(count));
    expect(lines).toHaveLength(1);
    for (const item of cases(count)) expect(lines[0]).toContain(item.title);
  });

  it('deduplicates existing and repeated cases and waits for four novel cases', () => {
    const candidates = cases(5);
    expect(plan([...candidates, { ...candidates[1], title: '  CASE   2 ' }], { existing: [candidates[0]] })).toHaveLength(1);
    expect(plan(candidates, { existing: candidates.slice(0, 2) })).toEqual([]);
    expect(plan([candidates[0], candidates[0], candidates[1], candidates[2]])).toEqual([]);
  });

  it('caps batches at eight and defers additional work on that file', () => {
    const lines = plan(cases(12));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Case 8');
    expect(lines[0]).not.toContain('Case 9');
    expect(plan(cases(12), { queue: lines[0] })).toEqual([]);
  });

  it('blocks active targets from claims and queue rows but scopes them by repo and file', () => {
    const all = [...cases(4), ...cases(4, 'test/other.test.ts'), ...cases(4, 'test/example.test.ts', 'locus')];
    const queue = '- CLAIMED OTHER (repo=phantom): work in test/example.test.ts\n';
    expect(plan(all, { queue, activeFiles: [{ repo: 'phantom', file: 'test/other.test.ts' }] })).toHaveLength(1);
    expect(plan(cases(4), { queue: queue.replace('CLAIMED', 'DONE') })).toHaveLength(1);
  });

  it('appends once to a fresh locked queue snapshot', () => {
    const input = { candidates: cases(4), existing: [], activeFiles: [], queue: 'header' };
    const result = restockTestQueue(input);
    expect(result.queue).toBe(`header\n${result.added[0]}\n`);
    expect(restockTestQueue({ ...input, queue: result.queue }).added).toEqual([]);
  });

  it('does not recreate completed batch IDs and rejects unsafe inputs', () => {
    const line = plan(cases(4))[0];
    expect(plan(cases(4), { queue: line.replace('READY', 'DONE') })).toEqual([]);
    expect(plan(cases(4, '../test/bad.test.ts'))).toEqual([]);
    expect(plan(cases(4).map(item => ({ ...item, title: `${item.title}\n- READY injected` })))).toEqual([]);
  });
});
