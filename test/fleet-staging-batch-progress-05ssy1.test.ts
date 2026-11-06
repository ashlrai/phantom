import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetStagingInventoryBatch } from '../src/cli/fleet-staging-inventory-batch.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { ELIGIBILITY, inventoryStaging } from '../src/core/fleet/staging-inventory.js';

type Report = Awaited<ReturnType<typeof inventoryStaging>>;
const report = (root: string): Report => ({
  schema: 'fleet.staging-inventory.v1', generatedAt: '2026-01-01T00:00:00.000Z', root,
  source: 'ok', complete: true, truncated: false, skippedSymlinks: 0,
  entries: [{ name: `${homedir()}/fake`, modifiedAt: 'x', bytes: null }], totalMeasuredBytes: 0,
  cleanupEligibility: ELIGIBILITY,
});
const input = (value: string) => (async function* () { yield value; })();
const envelope = (roots: string[]) => JSON.stringify({ version: 1, roots });

describe('staging batch progress', () => {
  it('emits each sanitized result before the next scan finishes and summarizes failures', async () => {
    const lines: string[] = [], calls: string[] = [];
    let rejectSecond!: (error: Error) => void;
    let enteredSecond!: () => void;
    const entered = new Promise<void>(resolve => { enteredSecond = resolve; });
    const deferred = new Promise<Report>((_resolve, reject) => { rejectSecond = reject; });
    const run = cmdFleetStagingInventoryBatch(['--stdin', '--ndjson'], {
      input: input(envelope(['/fake/a/.', '/fake/b', '/fake/c'])),
      scanner: async root => {
        calls.push(root);
        if (root === '/fake/b') { enteredSecond(); return deferred; }
        return report(root);
      },
      output: { log: line => lines.push(line), error: () => { throw new Error('unexpected error'); } },
    });
    await entered;
    expect(calls).toEqual(['/fake/a', '/fake/b']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: 'fleet.staging-inventory-batch-progress.v1', index: 0, requested: 3, report: { root: '/fake/a', cleanupEligibility: ELIGIBILITY } });
    expect(lines[0]).not.toContain(homedir());
    rejectSecond(new Error('private exception'));
    expect(await run).toBe(1);
    expect(calls).toEqual(['/fake/a', '/fake/b', '/fake/c']);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[1]!)).toEqual({ schema: 'fleet.staging-inventory-batch-progress.v1', index: 1, requested: 3, report: { root: '/fake/b', complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY } });
    expect(JSON.parse(lines[2]!)).toMatchObject({ index: 2, report: { root: '/fake/c', cleanupEligibility: ELIGIBILITY } });
    expect(JSON.parse(lines[3]!)).toEqual({ schema: 'fleet.staging-inventory-batch-summary.v1', requested: 3, completed: 2, complete: false });
    expect(lines.join('\n')).not.toContain('private exception');
  });

  it('rejects invalid flags and envelopes before any scan or progress output', async () => {
    for (const [args, value] of [
      [['--stdin', '--ndjson', '--json'], envelope(['/a'])],
      [['--stdin', '--ndjson', '--unknown'], envelope(['/a'])],
      [['--stdin', '--ndjson', '--ndjson'], envelope(['/a'])],
      [['--stdin', '--ndjson'], '{}'],
      [['--stdin', '--ndjson'], envelope(['/a', '/a/.'])],
      [['--stdin', '--ndjson'], envelope(['relative'])],
      [['--stdin', '--ndjson'], envelope(Array.from({ length: 9 }, (_, i) => `/a${i}`))],
      [['--stdin', '--ndjson'], ' '.repeat(16385)],
    ] as [string[], string][]) {
      const lines: string[] = []; let calls = 0;
      expect(await cmdFleetStagingInventoryBatch(args, { input: input(value), scanner: async root => { calls++; return report(root); }, output: { log: line => lines.push(line), error: () => {} } })).toBe(2);
      expect(calls).toBe(0); expect(lines).toEqual([]);
    }
  });

  it('retains the aggregate JSON contract', async () => {
    const lines: string[] = [];
    expect(await cmdFleetStagingInventoryBatch(['--stdin', '--json'], { input: input(envelope(['/a'])), scanner: async root => report(root), output: { log: line => lines.push(line), error: () => {} } })).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: 'fleet.staging-inventory-batch.v1', requested: 1, completed: 1, reports: [{ root: '/a', cleanupEligibility: ELIGIBILITY }] });
  });

  it('runs real fixture inventories through the fleet loader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-progress-'));
    try {
      const roots = [join(dir, 'first'), join(dir, 'second')];
      roots.forEach(root => mkdirSync(root));
      const command = (await FLEET_SUBCOMMAND_LOADERS['staging-inventory-batch']!()).cmdFleetStagingInventoryBatch as typeof cmdFleetStagingInventoryBatch;
      const lines: string[] = [];
      expect(await command(['--stdin', '--ndjson'], { input: input(envelope(roots)), output: { log: line => lines.push(line), error: () => {} } })).toBe(0);
      expect(lines.map(line => JSON.parse(line))).toMatchObject([
        { index: 0, report: { root: roots[0], complete: true, cleanupEligibility: ELIGIBILITY } },
        { index: 1, report: { root: roots[1], complete: true, cleanupEligibility: ELIGIBILITY } },
        { schema: 'fleet.staging-inventory-batch-summary.v1', requested: 2, completed: 2, complete: true },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
