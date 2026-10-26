/** Cold pure-schema imports must not load account collectors or worker transports. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ module: vi.fn(), io: vi.fn() }));
const denied = () => { guards.module(); throw new Error('Effect module imported by pure schema'); };
vi.mock('../src/core/resources/worker.js', () => denied());
vi.mock('../src/core/resources/quota-refresh.js', () => denied());
vi.mock('../src/core/resources/connection-monitor.js', () => denied());
vi.mock('../src/core/resources/pool-commissioning-custody.js', () => denied());
vi.mock('../src/core/resources/pool-commissioning.js', () => denied());
vi.mock('../src/core/run/provider-client.js', () => denied());
vi.mock('../src/core/run/verify-commands.js', () => denied());
vi.mock('../src/core/config.js', () => denied());
vi.mock('../src/core/fabric/resource-monitor.js', () => denied());
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  execFileSync: (..._args: unknown[]) => { guards.io(); throw new Error('Schema invoked an OS command'); },
  spawn: (..._args: unknown[]) => { guards.io(); throw new Error('Schema invoked a process'); },
  spawnSync: (..._args: unknown[]) => { guards.io(); throw new Error('Schema invoked a process'); },
}));
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  const refuse = (..._args: unknown[]) => { guards.io(); throw new Error('Schema accessed storage'); };
  return { ...real, readFileSync: refuse, readSync: refuse, lstatSync: refuse, statSync: refuse,
    openSync: refuse, writeFileSync: refuse, mkdirSync: refuse, readdirSync: refuse };
});

afterEach(() => { expect(guards.module).not.toHaveBeenCalled(); expect(guards.io).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

const worker = { id: 'general', provider: 'codex', model: 'inert', maxConcurrent: 1,
  reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 0 };
const pool = { schemaVersion: 1, id: 'cold-config', workers: [worker, { ...worker, id: 'spark' }] };
const bindings = [
  { workerId: 'general', capacityKey: 'personal', kind: 'native-cli', command: ['/private/inert-wrapper'] },
  { workerId: 'spark', capacityKey: 'personal', kind: 'native-cli', command: ['/private/inert-wrapper'] },
];

describe('pure commissioning configuration import boundary', () => {
  it('validates roster, bindings and whole-alias quota without configuration, provider, OS or storage contact', async () => {
    vi.stubGlobal('fetch', () => { guards.io(); throw new Error('Schema contacted a provider'); });
    const [{ validateResourceConnectionConfig }, { validateResourceBindings }, quota, { canonical, digest }] = await Promise.all([
      import('../src/core/resources/connection-config.js'), import('../src/core/resources/worker-bindings.js'),
      import('../src/core/resources/quota-refresh-config.js'), import('../src/core/universe/artifacts.js'),
    ]);
    const roster = { schemaVersion: 1, intervalMs: 30_000, accounts: [
      { id: 'personal', label: 'Inert metadata', provider: 'codex', command: ['/private/inert-wrapper'], expectedAccountHint: 'a'.repeat(64) },
    ] };
    expect(validateResourceConnectionConfig(roster)).toEqual(roster);
    const checked = validateResourceBindings(bindings, pool as Parameters<typeof validateResourceBindings>[1]);
    expect(checked).toEqual(bindings); expect(Object.isFrozen(checked)).toBe(true);
    const config = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings: checked })),
      workers: ['general', 'spark'].map(workerId => ({ workerId, accountHint: 'a'.repeat(64), bucketIds: ['codex'] })) };
    expect(quota.validateResourceQuotaRefreshConfig(config, pool as Parameters<typeof validateResourceBindings>[1], checked)).toEqual(config);
    expect(() => quota.validateResourceQuotaRefreshConfig({ ...config, workers: config.workers.slice(0, 1) },
      pool as Parameters<typeof validateResourceBindings>[1], checked)).toThrow('Invalid resource quota refresh configuration');
    expect(quota.RESOURCE_QUOTA_REFRESH_INTERVAL_MS).toBe(30_000); expect(quota.RESOURCE_QUOTA_REFRESH_TTL_MS).toBe(60_000);
  });
});
