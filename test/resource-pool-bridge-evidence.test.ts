import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qualifyResourceBridgeEvidence, type ResourceBridgeLane } from '../src/core/resources/pool-bridge-evidence.js';
import { planResourceAssignment, type ResourceWorker } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus, runResourceTask } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker-bindings.js';
import { projectResourceConsoleEvidence, validateResourceConsoleResponse } from '../src/core/web/resource-console-public.js';

const now = Date.now();
const models = { agy: 'gemini-4-neon-low', 'devin-flash': 'swe-2.1-max', zai: 'glm-5.3-flash' };
function fixture(lane: ResourceBridgeLane) {
  const accountDigest = 'a'.repeat(lane === 'zai' ? 32 : 64);
  const executableSha256 = 'b'.repeat(64);
  const pin = { accountDigest, executableSha256 };
  const worker: ResourceWorker = { id: 'seat', model: models[lane], provider: lane, bridge: pin, maxConcurrent: 4,
    maxTasksPerWindow: 8, taskWindowMs: 3_600_000, priority: 10, reservePercent: 10 };
  const evidence = { schema: 'resource-pool-bridge.v1', lane, model: worker.model, ...pin, observedAt: now - 1_000,
    expiresAt: now + 60_000, ...(lane === 'devin-flash' ? {
      billing: { kind: 'verified', plan: 'devin-cli-free' }, quota: { kind: 'unknown' },
      reservationCap: { maxConcurrent: 1, maxPerHour: 2 },
    } : {
      billing: { kind: 'owner-attested-plan', attestedAt: now - 10_000, attestationExpiresAt: now + 86_400_000,
        ...(lane === 'zai' ? { plan: 'zai-glm-coding-lite', autoRecharge: false } :
          { plan: 'google-ai-ultra-personal', useG1Credits: false }) },
      quota: { kind: 'measured', usedPercent: 20, observedAt: now - 2_000, resetsAt: now + 120_000 },
    }) };
  const pool = { schemaVersion: 1 as const, id: 'test', workers: [worker] };
  const snapshot = { pool, observations: [], allowedWorkerIds: ['seat'], activeCounts: {},
    taskReservationCounts: {}, nowMs: now };
  return { worker, pin, evidence, pool, snapshot };
}

describe('account-bound Mac bridge qualification', () => {
  it.each(['agy', 'devin-flash', 'zai'] as const)('qualifies only positive evidence for %s', lane => {
    const { evidence, snapshot } = fixture(lane);
    const plan = planResourceAssignment({ ...snapshot, bridgeEvidence: { seat: evidence } });
    expect(plan.candidates).toEqual([expect.objectContaining({ workerId: 'seat', bridgeEvidenceKind: evidence.billing.kind,
      usedPercent: lane === 'devin-flash' ? null : 20 })]);
    expect(planResourceAssignment(snapshot).exclusions[0]?.reasons).toContain('bridge-not-commissioned');
  });

  it.each([
    ['missing', (_e: ReturnType<typeof fixture>['evidence']) => null],
    ['wrong schema', e => ({ ...e, schema: 'other' })],
    ['wrong lane', e => ({ ...e, lane: 'agy' })],
    ['wrong model', e => ({ ...e, model: 'glm-5.3' })],
    ['wrong account', e => ({ ...e, accountDigest: 'c'.repeat(32) })],
    ['wrong executable', e => ({ ...e, executableSha256: 'c'.repeat(64) })],
    ['future', e => ({ ...e, observedAt: now + 1 })],
    ['expired', e => ({ ...e, expiresAt: now })],
    ['stale', e => ({ ...e, observedAt: now - 300_001 })],
    ['recharge on', e => ({ ...e, billing: { ...e.billing, autoRecharge: true } })],
    ['expired attestation', e => ({ ...e, billing: { ...e.billing, attestationExpiresAt: now } })],
    ['wrong plan', e => ({ ...e, billing: { ...e.billing, plan: 'metered' } })],
    ['wrong evidence kind', e => ({ ...e, billing: { ...e.billing, kind: 'verified' } })],
    ['missing recharge control', e => ({ ...e, billing: { ...e.billing, autoRecharge: undefined } })],
    ['future attestation', e => ({ ...e, billing: { ...e.billing, attestedAt: now + 1 } })],
    ['overlong attestation', e => ({ ...e, billing: { ...e.billing, attestationExpiresAt: now + 31 * 86_400_000 } })],
    ['overlong evidence', e => ({ ...e, expiresAt: now + 300_000 })],
    ['unknown quota', e => ({ ...e, quota: { kind: 'unknown' } })],
    ['invalid quota', e => ({ ...e, quota: { ...e.quota, usedPercent: 101 } })],
    ['stale quota', e => ({ ...e, quota: { ...e.quota, observedAt: now - 300_001 } })],
    ['future quota', e => ({ ...e, quota: { ...e.quota, observedAt: now + 1 } })],
    ['passed reset', e => ({ ...e, quota: { ...e.quota, resetsAt: now } })],
    ['missing reset', e => ({ ...e, quota: { ...e.quota, resetsAt: undefined } })],
    ['extra fields', e => ({ ...e, extra: true })],
  ] as const)('holds %s bridge evidence', (_name, alter) => {
    const { evidence, snapshot } = fixture('zai');
    expect(planResourceAssignment({ ...snapshot, bridgeEvidence: { seat: alter(evidence) } }).exclusions[0]?.reasons)
      .toContain('bridge-not-commissioned');
  });

  it('rejects Google credit use and applies exhausted quota without treating it as absent', () => {
    const { evidence, pin, worker, snapshot } = fixture('agy');
    expect(qualifyResourceBridgeEvidence({ ...evidence, billing: { ...evidence.billing, useG1Credits: true } },
      'agy', worker.model, pin, now)).toBeNull();
    const plan = planResourceAssignment({ ...snapshot, bridgeEvidence: { seat: { ...evidence, quota: { ...evidence.quota, usedPercent: 100 } } } });
    expect(plan.exclusions[0]?.reasons).toEqual(['quota-reserve-reached']);
  });

  it('requires verified Devin pricing and enforces the separate local cap', () => {
    const { evidence, snapshot } = fixture('devin-flash');
    for (const altered of [{ ...evidence, reservationCap: undefined },
      { ...evidence, reservationCap: { maxConcurrent: 0, maxPerHour: 3 } },
      { ...evidence, billing: { ...evidence.billing, kind: 'owner-attested-plan' } }]) {
      expect(planResourceAssignment({ ...snapshot, bridgeEvidence: { seat: altered } }).selectedWorkerId).toBeNull();
    }
    const plan = planResourceAssignment({ ...snapshot, bridgeEvidence: { seat: evidence }, activeCounts: { seat: 1 },
      taskReservationCounts: { seat: { count: 2, nextEligibleAt: null } } });
    expect(plan.exclusions[0]?.reasons).toEqual(['concurrency-exhausted', 'operator-task-cap-reached']);
  });

  it('reads private evidence for qualification but performs no reservation or launch', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pool-bridge-')));
    const root = join(dir, 'store');
    const cwd = join(dir, 'workspace');
    const { pool, evidence } = fixture('devin-flash');
    const bindings = validateResourceBindings([{ kind: 'mac-bridge', workerId: 'seat', capacityKey: 'account' }], pool);
    try {
      mkdirSync(join(root, 'bridge-evidence'), { recursive: true, mode: 0o700 });
      mkdirSync(cwd, { mode: 0o700 });
      const file = join(root, 'bridge-evidence', 'seat.json');
      const project = () => projectResourceConsoleEvidence(pool, bindings, resourcePoolStatus(root, pool, bindings, []));
      expect(validateResourceConsoleResponse(JSON.stringify(project()), pool, bindings).plan?.exclusions[0]?.reasons)
        .toContain('bridge-not-commissioned');
      writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 });
      expect(resourcePoolStatus(root, pool, bindings, []).plan.selectedWorkerId).toBe('seat');
      const visible = JSON.stringify(project());
      expect(visible).not.toContain(evidence.accountDigest);
      expect(validateResourceConsoleResponse(visible, pool, bindings).plan?.candidates[0]?.bridgeEvidenceKind).toBe('verified');
      const result = await runResourceTask({ root, pool, bindings, observations: [], task: {
        schemaVersion: 1, id: 'job', allowedWorkerIds: ['seat'], prompt: 'fixture', cwd,
        mode: 'read-only', timeoutMs: 1_000, maxOutputTokens: 32 } });
      expect(result.receipt).toBeNull();
      expect(result.plan?.exclusions[0]?.reasons).toContain('bridge-not-commissioned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
