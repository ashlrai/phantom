import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { planMergeBatches } from '../src/core/fleet/merge-batch.js';
import { cmdFleetMergeBatch } from '../src/cli/fleet-merge-batch.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const pr = (number: number, files: string[], ciMinutes: number, dependsOn: number[] = []) => ({ number, files, ciMinutes, dependsOn });
afterEach(() => vi.restoreAllMocks());

it('orders low overlap then CI cost, separates conflicts and honors dependencies', () => {
  const result = planMergeBatches([pr(1, ['a'], 1), pr(2, ['a'], 2), pr(3, ['b'], 3), pr(4, ['c'], 1), pr(5, ['d'], 1, [1])]);
  expect(result.batches.map(batch => batch.map(x => x.number))).toEqual([[4, 3, 1], [5, 2]]);
  expect(result.batches[0]![2]!.conflictRisk).toBe(1);
  expect(result.blocked).toEqual([]);
});

it('blocks missing, cyclic and transitively blocked dependencies', () => {
  const result = planMergeBatches([pr(1, ['a'], 1, [9]), pr(2, ['b'], 1, [3]), pr(3, ['c'], 1, [2]), pr(4, ['d'], 1, [1])]);
  expect(result.batches).toEqual([]);
  expect(result.blocked).toEqual([{ number: 1, unresolvedDependencies: [9] }, { number: 2, unresolvedDependencies: [3] }, { number: 3, unresolvedDependencies: [2] }, { number: 4, unresolvedDependencies: [1] }]);
});

it('rejects ambiguous or incomplete snapshots', () => {
  for (const input of [{}, [pr(1, [], 1)], [pr(1, ['a'], 0)], [pr(1, ['a'], 1), pr(1, ['b'], 1)], [{ number: 1, files: ['a'], ciMinutes: 1 }]]) {
    expect(() => planMergeBatches(input)).toThrow();
  }
});

it('exposes a read-only CLI with strict arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-batch-'));
  const path = join(dir, 'input.json');
  await writeFile(path, JSON.stringify([pr(1, ['a'], 2)]));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetMergeBatch(['--input', path, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string).batches[0][0].number).toBe(1);
  expect(await cmdFleetMergeBatch(['--input', '/missing'])).toBe(1);
  expect(await cmdFleetMergeBatch(['--json'])).toBe(2);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['merge-batch']!()).cmdFleetMergeBatch).toBe('function');
});
