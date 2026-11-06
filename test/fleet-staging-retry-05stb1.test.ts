import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetStagingInventoryBatch } from '../src/cli/fleet-staging-inventory-batch.js';
import { cmdFleetStagingInventoryRetry } from '../src/cli/fleet-staging-inventory-retry.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { inventoryStaging } from '../src/core/fleet/staging-inventory.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stream = (text: string) => (async function* () { yield text; })();
const capture = () => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, output: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) } };
};

it('retries only incomplete reports from a real batch and preserves completed evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-retry-')); dirs.push(dir);
  const good = join(dir, 'good'); const bad = join(dir, 'bad');
  mkdirSync(good); writeFileSync(bad, 'fake');
  const batch = capture();
  expect(await cmdFleetStagingInventoryBatch(['--stdin', '--json'], { input: stream(JSON.stringify({ version: 1, roots: [good, bad] })), output: batch.output })).toBe(1);
  const original = JSON.parse(batch.lines[0]!);
  rmSync(bad); mkdirSync(bad);
  const scan = vi.fn(inventoryStaging);
  const retry = capture();
  expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(batch.lines[0]!), output: retry.output, scanner: scan })).toBe(0);
  expect(scan).toHaveBeenCalledTimes(1); expect(scan).toHaveBeenCalledWith(bad);
  const result = JSON.parse(retry.lines[0]!);
  expect(result.reports[0]).toEqual(original.reports[0]);
  expect(result.reports.map((r: { root: string }) => r.root)).toEqual([good, bad]);
  const again = capture(); scan.mockClear();
  expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(retry.lines[0]!), output: again.output, scanner: scan })).toBe(0);
  expect(scan).not.toHaveBeenCalled();
});

it('rejects invalid and oversized reports before scanning', async () => {
  const report = { schema: 'fleet.staging-inventory-batch.v1', requested: 1, completed: 0, reports: [{ root: '/fake', complete: false, source: 'failed' }] };
  const bad = [ 'x', 'x'.repeat(1024 * 1024 + 1), JSON.stringify({ ...report, completed: 1 }),
    JSON.stringify({ ...report, requested: 2 }), JSON.stringify({ ...report, reports: [{ ...report.reports[0], root: '/fake/../fake' }] }),
    JSON.stringify({ ...report, requested: 2, reports: [report.reports[0], report.reports[0]] }),
    JSON.stringify({ ...report, reports: [{ ...report.reports[0], complete: 'false' }] }) ];
  const scan = vi.fn(inventoryStaging);
  for (const input of bad) {
    const out = capture();
    expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(input), output: out.output, scanner: scan })).toBe(2);
    expect(out.lines).toEqual([]);
  }
  expect(scan).not.toHaveBeenCalled();
});

it('keeps a scanner exception incomplete without exposing the error', async () => {
  const input = JSON.stringify({ schema: 'fleet.staging-inventory-batch.v1', requested: 1, completed: 0, reports: [{ root: '/fake', complete: false, source: 'failed' }] });
  const out = capture();
  expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(input), output: out.output, scanner: async () => { throw new Error('private detail'); } })).toBe(1);
  expect(out.lines[0]).not.toContain('private detail');
  expect(JSON.parse(out.lines[0]!).reports[0]).toMatchObject({ root: '/fake', complete: false, source: 'failed' });
});

it('is reachable through the generated loader and the real dispatcher', async () => {
  const verb = 'staging-inventory-retry';
  const resolved = resolveFleetSubcommand(verb);
  expect(resolved).toEqual({ module: './fleet-staging-inventory-retry.js', exportName: 'cmdFleetStagingInventoryRetry' });
  expect((await FLEET_SUBCOMMAND_LOADERS[verb]!())[resolved!.exportName]).toBe(cmdFleetStagingInventoryRetry);
  const dir = mkdtempSync(join(tmpdir(), 'staging-dispatch-')); dirs.push(dir);
  const batch = spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/cli/index.ts'), 'fleet', 'staging-inventory-batch', '--stdin', '--json'], { input: JSON.stringify({ version: 1, roots: [dir] }), encoding: 'utf8' });
  expect(batch.status).toBe(0);
  const retry = spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/cli/index.ts'), 'fleet', verb, '--stdin', '--json'], { input: batch.stdout, encoding: 'utf8' });
  expect(retry.status).toBe(0); expect(JSON.parse(retry.stdout).completed).toBe(1);
});
