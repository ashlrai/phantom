import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readLaunchCosts } from '../src/core/fleet/launch-cost.js';
import { cmdFleetVitals } from '../src/cli/fleet-vitals.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const row = { schema: 'fleet.launch-cost.v1', lane: 'codex', launchId: 'RQ-A.1', startedAt: '2026-11-16T00:00:00Z', windowSeconds: 60, sampledSeconds: 60, samples: 13, peakProcesses: 6, meanCpuPercentOneCore: 50, peakCpuPercentOneCore: 125, status: 'measured' };
async function fixture(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'launch-cost-')); roots.push(root);
  await mkdir(join(root, 'metrics')); await writeFile(join(root, 'metrics/launch-cost.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  return root;
}
it('reads measured, partial and unknown costs while projecting only metadata', async () => {
  const root = await fixture([{ ...row, privatePayload: 'must-not-escape' }, { ...row, status: 'partial', sampledSeconds: 20 }, { ...row, status: 'unknown', peakProcesses: null, meanCpuPercentOneCore: null, peakCpuPercentOneCore: null }]);
  const report = await readLaunchCosts(root);
  expect(report.launches.map(r => r.status)).toEqual(['measured', 'partial', 'unknown']);
  expect((await readLaunchCosts(await fixture([{ ...report.launches[2], startedAt: null }]))).state).toBe('unknown');
  expect((await readLaunchCosts(await fixture([{ ...row, sampledSeconds: 59.2 }]))).launches[0]?.sampledSeconds).toBe(59.2);
  expect(JSON.stringify(report)).not.toContain('must-not-escape');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root, '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0])).launchCost.launches).toHaveLength(3);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS.vitals!()).cmdFleetVitals).toBe('function');
});
it('fails closed for missing, malformed, incomplete and symlink evidence; bounds output', async () => {
  const root = await fixture([{ ...row, sampledSeconds: 58.9 }, { ...row, peakProcesses: -1 }, { ...row, meanCpuPercentOneCore: 200 }, null]);
  expect(await readLaunchCosts(root)).toMatchObject({ source: 'degraded', state: 'unknown', launches: [] });
  await rm(join(root, 'metrics/launch-cost.jsonl'));
  expect(await readLaunchCosts(root)).toMatchObject({ source: 'missing', state: 'unknown' });
  await writeFile(join(root, 'private'), JSON.stringify(row)); await symlink(join(root, 'private'), join(root, 'metrics/launch-cost.jsonl'));
  expect(await readLaunchCosts(root)).toMatchObject({ source: 'degraded', launches: [] });
  expect((await readLaunchCosts(await fixture(Array.from({ length: 101 }, () => row)))).launches).toHaveLength(100);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--json', '--json'])).toBe(2); expect(await cmdFleetVitals(['--runs-dir'])).toBe(2);
});
