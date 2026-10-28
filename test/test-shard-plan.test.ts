import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  assertExactFilters, durationsFromReports, mergeDurations, parseDurations, parseInventory, planShards, readDurations,
  serializeDurations,
} from '../scripts/test-shard-plan.mjs';

const schema = 'phantom-test-durations/v1';
const files = (count: number) => Array.from({ length: count }, (_, index) => `test/f${String(index).padStart(2, '0')}.test.ts`);

describe('planShards', () => {
  it('assigns longest files first to the least-loaded shard', () => {
    const durations = new Map([
      ['test/a.test.ts', 70], ['test/b.test.ts', 50], ['test/c.test.ts', 40], ['test/d.test.ts', 30],
      ['test/e.test.ts', 20], ['test/f.test.ts', 10],
    ]);
    const { shards, unmeasured } = planShards([...durations.keys()].reverse(), durations, 3);
    expect(shards).toEqual([
      { files: ['test/a.test.ts', 'test/f.test.ts'], estimatedMs: 80 },
      { files: ['test/b.test.ts', 'test/e.test.ts'], estimatedMs: 70 },
      { files: ['test/c.test.ts', 'test/d.test.ts'], estimatedMs: 70 },
    ]);
    expect(unmeasured).toEqual([]);
  });

  it('beats a count split on a skewed suite and keeps every file exactly once', () => {
    const inventory = files(40);
    // A quarter of the files carry most of the time, like the real-I/O tail.
    const durations = new Map(inventory.map((file, index) => [file, index % 4 === 0 ? 20_000 : 500]));
    const { shards } = planShards(inventory, durations, 4);
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual(inventory);
    const loads = shards.map((shard) => shard.estimatedMs);
    const total = loads.reduce((sum, ms) => sum + ms, 0);
    // LPT's bound: no shard exceeds the ideal share by more than its last file.
    expect(Math.max(...loads)).toBeLessThanOrEqual(total / 4 + 20_000);
    // Contiguous count split for comparison: ten files each, same total.
    const countLoads = [0, 1, 2, 3].map((shard) => inventory.slice(shard * 10, shard * 10 + 10)
      .reduce((sum, file) => sum + durations.get(file)!, 0));
    expect(Math.max(...loads)).toBeLessThan(Math.max(...countLoads));
  });

  it('estimates unmeasured files at the median and reports them', () => {
    const durations = new Map([['test/f00.test.ts', 100], ['test/f01.test.ts', 300], ['test/f02.test.ts', 900]]);
    const plan = planShards(files(5), durations, 2);
    expect(plan.estimateMs).toBe(300);
    expect(plan.unmeasured).toEqual(['test/f03.test.ts', 'test/f04.test.ts']);
    expect(plan.shards.map((shard) => shard.estimatedMs).sort((a, b) => a - b)).toEqual([900, 1_000]);
  });

  it('balances by file count when nothing is measured', () => {
    const plan = planShards(files(10), new Map(), 4);
    expect(plan.shards.map((shard) => shard.files.length)).toEqual([3, 3, 2, 2]);
    expect(plan.unmeasured).toHaveLength(10);
  });

  it('is deterministic regardless of inventory order', () => {
    const inventory = files(25);
    const durations = new Map(inventory.map((file, index) => [file, (index * 37) % 11 * 100]));
    const forward = planShards(inventory, durations, 4);
    expect(planShards([...inventory].reverse(), durations, 4)).toEqual(forward);
  });

  it('allows more shards than files and rejects invalid input', () => {
    const plan = planShards(files(2), new Map(), 4);
    expect(plan.shards.map((shard) => shard.files.length)).toEqual([1, 1, 0, 0]);
    expect(() => planShards(files(2), new Map(), 0)).toThrow('shard count must be a positive integer');
    expect(() => planShards(['test/a.test.ts', 'test/a.test.ts'], new Map(), 2)).toThrow('duplicate file');
  });
});

describe('durations documents', () => {
  it('round-trips sorted integer milliseconds', () => {
    const durations = new Map([['test/z.test.ts', 5], ['test/a.test.ts', 7]]);
    const text = serializeDurations(durations);
    expect(text).toBe(`${JSON.stringify({ schema, files: { 'test/a.test.ts': 7, 'test/z.test.ts': 5 } }, null, 2)}\n`);
    expect(parseDurations(text)).toEqual(new Map([['test/a.test.ts', 7], ['test/z.test.ts', 5]]));
  });

  it.each([
    [{ schema: 'other', files: {} }, 'unsupported durations schema'],
    [{ schema, files: [] }, 'durations files must be an object'],
    [{ schema, files: { 'src/a.ts': 1 } }, 'invalid durations path'],
    [{ schema, files: { 'test/../a.test.ts': 1 } }, 'invalid durations path'],
    [{ schema, files: { 'test/a.test.ts': 1.5 } }, 'invalid duration'],
    [{ schema, files: { 'test/a.test.ts': -1 } }, 'invalid duration'],
  ])('rejects %j', (doc, message) => {
    expect(() => parseDurations(JSON.stringify(doc))).toThrow(message);
  });

  it('treats a missing durations file as no measurements', () => {
    expect(readDurations(join('/nonexistent', 'test-durations.json'))).toEqual(new Map());
  });

  it('sums per-file report spans and ignores files outside test/', () => {
    const root = '/repo';
    const observed = durationsFromReports([
      { testResults: [{ name: '/repo/test/a.test.ts', startTime: 10, endTime: 110.4 }, { name: '/repo/src/x.ts', startTime: 0, endTime: 5 }] },
      { testResults: [{ name: '/repo/test/a.test.ts', startTime: 0, endTime: 50 }, { name: '/repo/test/b.test.ts', startTime: 5, endTime: 1 }] },
    ], root);
    expect(observed).toEqual(new Map([['test/a.test.ts', 150]]));
    expect(() => durationsFromReports([{}], root)).toThrow('report has no testResults');
  });

  it('merges observed over previous and drops deleted files', () => {
    const merged = mergeDurations(new Map([['test/a.test.ts', 1], ['test/gone.test.ts', 2]]),
      new Map([['test/a.test.ts', 3], ['test/b.test.ts', 4]]), (file) => file !== 'test/gone.test.ts');
    expect(merged).toEqual(new Map([['test/a.test.ts', 3], ['test/b.test.ts', 4]]));
  });
});

describe('inventory and filters', () => {
  it('parses vitest list output into sorted relative paths', () => {
    expect(parseInventory([{ file: '/repo/test/b.test.ts' }, { file: '/repo/test/a.test.ts' }], '/repo'))
      .toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(() => parseInventory([], '/repo')).toThrow('vitest list returned no test files');
    expect(() => parseInventory([{ file: '/repo/test/a.test.ts' }, { file: '/repo/test/a.test.ts' }], '/repo'))
      .toThrow('vitest list reported a file twice');
    expect(() => parseInventory([{ file: '/elsewhere/test/a.test.ts' }], '/repo')).toThrow('unexpected collected path');
  });

  it('accepts filters that select only their own file', () => {
    expect(() => assertExactFilters(['test/a.test.ts', 'test/m1.test.ts'],
      ['test/a.test.ts', 'test/m1.test.ts', 'test/m11.test.ts', 'test/sub/b.test.ts'])).not.toThrow();
  });

  it.each([
    [['test/a.test.ts'], ['test/a.test.ts', 'test/xtest/a.test.ts'], 'would select 2'],
    [['test/A.test.ts'], ['test/a.test.ts', 'test/A.test.ts'], 'would select 2'],
    [['test/a.test.ts'], ['test/b.test.ts'], 'would select 0'],
  ])('rejects ambiguous or missing filter %j (row %#)', (selected, collected, message) => {
    expect(() => assertExactFilters(selected, collected)).toThrow(message);
  });
});
