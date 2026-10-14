/** Real private lifecycle lease with inert proof/probe ports; no provider or native CLI calls. */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { refreshResourceQuotaOnce, ResourceQuotaRefreshError } from '../src/core/resources/quota-refresh.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { CodexResourceProbeOptions, CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';
import * as proof from '../src/core/resources/pool-commissioning-evidence.js';
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'commissioning-collector-'))); });
afterEach(() => {
  vi.restoreAllMocks();
  // Remove only the whole private test fixture after custody assertions. No
  // scenario clears/reconciles a marker to make collection or cleanup succeed.
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const pool: ResourcePool = { schemaVersion: 1, id: 'collector-capture-fixture', workers: [{ id: 'general', provider: 'codex',
    model: 'inert-fixture', maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'general', capacityKey: 'personal', kind: 'native-cli', command: ['/inert-never-invoked/codex'] }];
  const config = { schemaVersion: 1 as const, poolDigest: digest(canonical({ pool, bindings })),
    workers: [{ workerId: 'general', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] };
  const cwd = join(root, 'ledger');
  return { options: { pool, bindings, config, cwd, observations: [], timeoutMs: 5000 },
    marker: join(cwd, '.resource-quota-refresh-pending.json'), lock: join(cwd, '.resource-quota-refresh.lock'),
    activity: () => JSON.parse(readFileSync(join(cwd, '.resource-quota-refresh-activity.json'), 'utf8')) };
}
function result(options: CodexResourceProbeOptions, status: CodexResourceProbeResult['status'] = 'observed'): CodexResourceProbeResult {
  const at = new Date().toISOString();
  return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId,
    poolDigest: digest(canonical({ pool: options.pool, bindings: options.bindings })), status,
    reason: 'inert-probe-result', startedAt: at, finishedAt: at, accountHint: options.expectedAccountHint!, planType: 'pro',
    observation: status === 'observed' ? { workerId: options.workerId, observedAt: at,
      expiresAt: new Date(Date.parse(at) + 60_000).toISOString(), health: 'ready', retryAfter: null,
      windows: [{ id: 'codex_primary', usedPercent: 20, resetsAt: new Date(Date.parse(at) + 3_600_000).toISOString() }] } : null };
}
function settledProbe(f: ReturnType<typeof fixture>, status: CodexResourceProbeResult['status'] = 'observed') {
  return vi.fn(async (options: CodexResourceProbeOptions) => {
    expect(f.activity().reservations).toEqual([{ id: expect.any(String), phase: 'ready', pgid: null, launchId: null }]);
    const prepared = options.processGroupLifecycle!.prepare();
    expect(f.activity().reservations[0].phase).toBe('preparing');
    prepared.settled('not-started'); // Source-owned proof: this port spawns nothing.
    expect(f.activity().reservations[0].phase).toBe('ready');
    return result(options, status);
  });
}
function assertClosed(f: ReturnType<typeof fixture>) {
  expect(existsSync(f.marker)).toBe(false); expect(existsSync(f.lock)).toBe(false);
  expect(f.activity().reservations).toEqual([]);
}
describe.skipIf(process.platform !== 'darwin')('commissioning capture lifecycle distinctions', () => {
  it('closes the known no-contact reservation when pre-capture fails without invoking any probe', async () => {
    const f = fixture(); const capture = vi.spyOn(proof, 'captureResourceCommissioningObservation').mockImplementation(() => { throw new Error('inert proof unavailable'); });
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => result(options));
    const observed = await refreshResourceQuotaOnce({ ...f.options, _probe: probe });
    expect(probe).not.toHaveBeenCalled(); expect(capture).toHaveBeenCalledOnce();
    expect(observed).toMatchObject({ observations: [], unavailableWorkerIds: ['general'] }); assertClosed(f);
  });
  it('collects a valid inert result when before/after proof is unchanged', async () => {
    const f = fixture(); vi.spyOn(proof, 'captureResourceCommissioningObservation').mockReturnValue(null);
    const probe = settledProbe(f); const observed = await refreshResourceQuotaOnce({ ...f.options, _probe: probe });
    expect(probe).toHaveBeenCalledOnce(); expect(observed.observations).toHaveLength(1);
    expect(observed.unavailableWorkerIds).toEqual([]); assertClosed(f);
  });
  it.each(['observed', 'failed', 'timed-out', 'cancelled'] as const)('post-capture failure invalidates %s evidence without inventing termination uncertainty', async status => {
    const f = fixture(); const capture = vi.spyOn(proof, 'captureResourceCommissioningObservation').mockReturnValueOnce(null)
      .mockImplementationOnce(() => { throw new Error('inert proof changed after known settlement'); });
    const probe = settledProbe(f, status); const observed = await refreshResourceQuotaOnce({ ...f.options, _probe: probe });
    expect(probe).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledTimes(2);
    expect(observed).toMatchObject({ observations: [], unavailableWorkerIds: ['general'] }); assertClosed(f);
  });
  it('post-capture mismatch invalidates fresh quota while preserving confirmed lifecycle cleanup', async () => {
    const f = fixture(); vi.spyOn(proof, 'captureResourceCommissioningObservation').mockReturnValueOnce(null).mockReturnValueOnce({
      planDigest: '1'.repeat(64), poolDigest: '2'.repeat(64), profileMetadataDigest: '3'.repeat(64), profileEpochDigest: '4'.repeat(64),
      collectorBindingDigest: '5'.repeat(64), collectorOwner: '6'.repeat(64) });
    const probe = settledProbe(f); const observed = await refreshResourceQuotaOnce({ ...f.options, _probe: probe });
    expect(probe).toHaveBeenCalledOnce(); expect(observed).toMatchObject({ observations: [], unavailableWorkerIds: ['general'] }); assertClosed(f);
  });
  it.each(['throw', 'uncertain'] as const)('retains the actual unresolved native fence after probe %s', async kind => {
    const f = fixture(); const capture = vi.spyOn(proof, 'captureResourceCommissioningObservation').mockReturnValue(null);
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => {
      if (kind === 'throw') throw new Error('PRIVATE_INERT_FAILURE');
      return result(options, 'uncertain');
    });
    const failure = await refreshResourceQuotaOnce({ ...f.options, _probe: probe }).catch(error => error);
    expect(failure).toBeInstanceOf(ResourceQuotaRefreshError); expect(failure).not.toHaveProperty('observations');
    expect(probe).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledOnce();
    expect(existsSync(f.marker)).toBe(true); expect(existsSync(f.lock)).toBe(false);
    expect(f.activity().reservations).toEqual([{ id: expect.any(String), phase: 'ready', pgid: null, launchId: null }]);
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_INERT_FAILURE');
  });
});
