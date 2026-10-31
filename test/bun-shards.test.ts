import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, parseTimings, planBunShards, readTimings, recordTimings } from '../scripts/bun-shards.mjs';

describe('Bun shard planning', () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({ file: `test/f${i}.test.ts`, bytes: (i + 1) * 100 }));
  const timings = new Map(rows.map((row, i) => [row.file, (i + 1) * 100]));

  it.each([2, 3, 4, 6])('balances fixture durations within 15 percent for %i shards', (count) => {
    const plan = planBunShards(rows, timings, count);
    const loads = plan.shards.map((shard) => shard.weight);
    const mean = loads.reduce((a, b) => a + b, 0) / count;
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(mean * 0.15);
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual(rows.map((row) => row.file).sort());
    expect(planBunShards([...rows].reverse(), timings, count)).toEqual(plan);
    expect(plan.fallbackFiles).toEqual([]);
  });

  it('balances by file size on a cold start and calibrates missing files from observations', () => {
    const cold = planBunShards(rows, new Map(), 4);
    expect(cold.unit).toBe('bytes');
    expect(cold.fallbackFiles).toHaveLength(24);
    const partial = planBunShards(rows, new Map([[rows[0].file, 200]]), 4);
    expect(partial.unit).toBe('estimated-ms');
    expect(partial.shards.reduce((sum, shard) => sum + shard.weight, 0))
      .toBe(rows.reduce((sum, row) => sum + row.bytes * 2, 0));
    expect(() => planBunShards(rows, timings, 0)).toThrow('positive integer');
    expect(planBunShards(rows.slice(0, 1), timings, 3).shards.map((s) => s.files.length)).toEqual([1, 0, 0]);
  });

  it('records exact file executions and refuses failed, signalled, or unavailable Bun', () => {
    const calls: unknown[] = [];
    let clock = 0;
    const text = recordTimings(rows.slice(0, 2), '/fixture', (...args) => {
      calls.push(args);
      return { status: 0 };
    }, () => { clock += 20; return clock; });
    expect(parseTimings(text)).toEqual(new Map([[rows[0].file, 20], [rows[1].file, 20]]));
    expect(calls[0]).toEqual(['bun', ['test', './test/f0.test.ts'], { cwd: '/fixture', stdio: 'inherit', timeout: 300_000 }]);
    for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('missing') }]) {
      expect(() => recordTimings(rows, '/fixture', () => result)).toThrow('Bun failed');
    }
  });

  it('rejects invalid timings rather than silently hiding corruption', () => {
    expect(readTimings('/nonexistent/phantom-bun-timings.json')).toEqual(new Map());
    expect(() => parseTimings('{}')).toThrow('schema');
    for (const ms of [0, -1, '100', null]) {
      expect(() => parseTimings(JSON.stringify({ schema: 'phantom-bun-timings/v1', files: { 'a.test.ts': ms } })))
        .toThrow('positive milliseconds');
    }
  });

  it('validates the live inventory, deduplicates aliases, and rejects symlink escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'bun-inventory-'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/a.test.ts'), 'test');
    expect(inventory(['test/a.test.ts'], root)).toEqual([{ file: 'test/a.test.ts', bytes: 4 }]);
    expect(() => inventory(['test/a.test.ts', './test/a.test.ts'], root)).toThrow('duplicate');
    expect(() => inventory([], root)).toThrow('nonempty');
    const outside = mkdtempSync(join(tmpdir(), 'bun-outside-'));
    writeFileSync(join(outside, 'escape.test.ts'), '');
    symlinkSync(join(outside, 'escape.test.ts'), join(root, 'test/escape.test.ts'));
    expect(() => inventory(['test/escape.test.ts'], root)).toThrow('escapes root');
  });
});
