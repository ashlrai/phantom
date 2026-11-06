import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('loads the resolved batch export and dispatches real inventories', async () => {
  const verb = 'staging-inventory-batch';
  const resolved = resolveFleetSubcommand(verb);
  expect(resolved).toEqual({ module: './fleet-staging-inventory-batch.js', exportName: 'cmdFleetStagingInventoryBatch' });
  const loader = FLEET_SUBCOMMAND_LOADERS[verb];
  expect(loader).toBeTypeOf('function');
  const command = (await loader!())[resolved!.exportName];
  expect(command).toBeTypeOf('function');

  const dir = mkdtempSync(join(tmpdir(), 'fleet-batch-'));
  dirs.push(dir);
  const roots = [join(dir, 'first'), join(dir, 'second')];
  for (const root of roots) {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'small.txt'), 'fake fixture');
  }
  const lines: string[] = [];
  const errors: string[] = [];
  const input = async function* () { yield JSON.stringify({ version: 1, roots }); };
  const invoke = command as (args: string[], deps: unknown) => Promise<number>;
  expect(await invoke(['--stdin', '--json'], { input: input(), output: { log: (line: string) => lines.push(line), error: (line: string) => errors.push(line) } })).toBe(0);
  expect(errors).toEqual([]);
  expect(lines).toHaveLength(1);
  const report = JSON.parse(lines[0]!);
  expect(report).toMatchObject({ schema: 'fleet.staging-inventory-batch.v1', requested: 2, completed: 2 });
  expect(report.reports.map((item: { root: string; complete: boolean }) => [item.root, item.complete])).toEqual(roots.map(root => [root, true]));
  expect(report.reports.map((item: { entries: unknown[] }) => item.entries.length)).toEqual([1, 1]);

  const run = (batchRoots: string[]) => spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/cli/index.ts'), 'fleet', verb, '--stdin', '--json'], {
    input: JSON.stringify({ version: 1, roots: batchRoots }), encoding: 'utf8',
  });
  const dispatched = run(roots);
  expect(dispatched.status).toBe(0);
  expect(JSON.parse(dispatched.stdout)).toMatchObject({ requested: 2, completed: 2 });
  for (const bad of [['relative'], [roots[0]!, join(roots[0]!, '.')]]) {
    const result = run(bad);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage:');
  }
  const file = join(dir, 'not-a-directory');
  writeFileSync(file, 'fake fixture');
  const incomplete = run([roots[0]!, file]);
  expect(incomplete.status).toBe(1);
  const partial = JSON.parse(incomplete.stdout);
  expect(partial).toMatchObject({ requested: 2, completed: 1 });
  expect(partial.reports[1]).toMatchObject({ root: file, complete: false, source: 'degraded' });
});
