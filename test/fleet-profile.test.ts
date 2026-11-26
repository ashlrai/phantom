import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { readPortableFleetLanes, resolvePortableFleetLanes } from '../src/core/fleet/portable-lanes.js';

it('runs the hermetic fleet profile regression suite', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'fleet.tests.test_profile'], { cwd, encoding: 'utf8', timeout: 25_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/\nOK(?: \(skipped=\d+\))?\s*$/);
}, 30_000);

it('only discovers an explicitly authorized lane with a registered resource and a matching ready executor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-profile-'));
  vi.stubEnv('ASHLR_HOME', root);
  try {
    const queue = join(root, 'queue');
    mkdirSync(queue);
    const declaration = (id: string, resource = 'custom:studio', authorized = true) => ({ id, resource, authorized });
    const profile = { schema: 'fleet.profile.v1', lanes: [
      { ...declaration('studio'), label: 'Engineering studio', floor: 2 }, declaration('not-approved', 'custom:studio', false),
      declaration('no-executor'), declaration('wrong-executor'), declaration('login-failed'),
      declaration('no-resource', 'custom:no-resource'), declaration('metered', 'custom:metered'),
      declaration('duplicate'), declaration('duplicate'),
    ] };
    const resource = { id: 'studio', name: 'Studio', provider: 'OpenAI', kind: 'subscription',
      source: 'cli-status', unit: 'points' };
    const slot = { executor_ready: true, target: 1, ceiling: 2, hard_cap: 2, resource_id: 'custom:studio' };
    writeFileSync(join(root, 'fleet-profile.json'), JSON.stringify(profile));
    writeFileSync(join(root, 'custom-resources.json'), JSON.stringify({ schema: 'custom-resources.v1', resources: [
      resource, { ...resource, id: 'metered', kind: 'metered' },
    ] }));
    writeFileSync(join(queue, 'slots.json'), JSON.stringify({
      studio: slot, 'not-approved': slot, 'wrong-executor': { ...slot, resource_id: 'custom:other' },
      'login-failed': { ...slot, auth_failed: true },
      metered: { ...slot, resource_id: 'custom:metered' }, duplicate: slot,
    }));
    const report = await readPortableFleetLanes(root);
    expect(report.find(lane => lane.id === 'studio')).toMatchObject({ label: 'Engineering studio', provider: 'OpenAI', state: 'ready' });
    expect(report.map(({ id, state }) => [id, state])).toEqual([
      ['studio', 'ready'], ['not-approved', 'not-authorized'], ['no-executor', 'executor-unavailable'],
      ['wrong-executor', 'executor-unavailable'], ['login-failed', 'executor-unavailable'], ['no-resource', 'resource-unavailable'],
      ['metered', 'resource-unavailable'],
    ]);
    expect(resolvePortableFleetLanes(null, { studio: slot }, [], 0)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
