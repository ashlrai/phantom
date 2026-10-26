/** Independent commissioning negatives; temporary private fixtures never contact providers. */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as privateWrites from '../src/core/util/private-file-write.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { checkResourcePoolCommissioning, applyResourcePoolCommissioning, resumeResourcePoolCommissioning } from '../src/core/resources/pool-commissioning.js';
import { resourcePoolStatus, runResourceTask, setResourcePoolAllocation, setResourceWorkerAccess,
  setResourceQuotaScopeAccess } from '../src/core/resources/pool-runtime.js';
import { createResourcePoolSupervisor, decodeResourceConsoleState } from '../src/core/resources/pool-supervisor.js';
import * as commissioningEvidence from '../src/core/resources/pool-commissioning-evidence.js';
import { createNativeMetadataCoordinator } from '../src/core/resources/metadata-coordinator.js';
import { qualifyResourceCommissioningObservations } from '../src/core/resources/pool-commissioning-evidence.js';
import { acquireResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { createResourceQuotaRefresher } from '../src/core/resources/quota-refresh.js';
import { publishSharedQuotaEvidence } from '../src/core/resources/quota-shared-evidence.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import { independentCommissioningFixture, independentTree, saveIndependentJson } from './support/pool-commissioning-independent-fixture.js';

type Fixture = ReturnType<typeof independentCommissioningFixture>;
const fixtures: Fixture[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
function fixture(): Fixture { const value = independentCommissioningFixture(); fixtures.push(value); return value; }
function apply(f: Fixture) {
  const plan = checkResourcePoolCommissioning(f.request);
  const report = applyResourcePoolCommissioning({ ...f.request, expectedPlanDigest: plan.planDigest });
  return { plan, report, pool: f.currentPool(), bindings: f.currentBindings(), quota: f.currentQuota(),
    custody: join(f.root, 'pool-commissioning', digest(canonical(f.request))) };
}
function apparentReady(f: Fixture) {
  const now = Date.now();
  return f.currentPool().workers.map((worker: { id: string }) => ({ workerId: worker.id, health: 'ready', retryAfter: null,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    windows: [{ id: worker.id === 'spark' ? 'codex_codex_bengalfox_primary' : 'codex_codex_primary', usedPercent: 0,
      resetsAt: new Date(now + 3_600_000).toISOString() }] }));
}
function task(f: Fixture, id: string) {
  return { schemaVersion: 1 as const, id, cwd: f.workspace, prompt: 'SYNTHETIC_INDEPENDENT_REQUEST',
    allowedWorkerIds: ['cmp'], mode: 'read-only' as const, timeoutMs: 1000, maxOutputTokens: 128 };
}
function localEpoch(f: Fixture, a: ReturnType<typeof apply>) {
  const pool = { ...a.pool, workers: [...a.pool.workers, { id: 'local', provider: 'local', model: 'inert-review',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 20, taskWindowMs: 60_000, priority: 1 }] };
  const bindings = [...a.bindings, { workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }];
  const options = { root: f.root, workspace: f.workspace, pool: a.pool, bindings: a.bindings, nextPool: pool, nextBindings: bindings };
  const plan = checkResourcePoolEvolution(options);
  applyResourcePoolEvolution({ ...options, expectedPlanDigest: plan.planDigest });
  const snapshot = resourcePoolConfigSnapshot(pool, bindings);
  saveIndependentJson(join(f.accountsRoot, 'pool.json'), snapshot.pool);
  saveIndependentJson(join(f.accountsRoot, 'bindings.json'), snapshot.bindings);
  saveIndependentJson(join(f.accountsRoot, 'quota-config.json'), { ...a.quota, poolDigest: snapshot.poolDigest });
  return snapshot;
}
function localObservation() {
  const now = Date.now(); return { workerId: 'local', health: 'ready' as const, retryAfter: null,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), windows: [] };
}
async function collector(f: Fixture, a: ReturnType<typeof apply>) {
  for (const profile of [f.personal, f.cmp]) saveIndependentJson(join(profile.nativeStatePath, 'auth.json'), {});
  const lease = await acquireResourceQuotaRefreshLease(f.root); lease.markPending();
  const refresher = createResourceQuotaRefresher({ pool: a.pool, bindings: a.bindings, config: a.quota, cwd: f.root,
    assertOwnership: () => lease.assertOwnership(),
    _probe: async options => {
      const now = Date.now(); const startedAt = new Date(now).toISOString();
      return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId, poolDigest: a.quota.poolDigest,
        status: 'observed', reason: 'synthetic-owned-capture', startedAt, finishedAt: startedAt,
        accountHint: options.expectedAccountHint ?? null, planType: 'synthetic', observation: {
          workerId: options.workerId, health: 'ready', retryAfter: null, observedAt: startedAt,
          expiresAt: new Date(now + 60_000).toISOString(), windows: options.bucketIds.map(bucket => ({
            id: `codex_${bucket}_primary`, usedPercent: 5, resetsAt: new Date(now + 3_600_000).toISOString() })) } };
    } });
  try {
    await vi.waitFor(() => expect(refresher.snapshot().workers.every(row => row.status === 'observed')).toBe(true), { timeout: 15_000 });
    const observations = refresher.readObservations([]);
    publishSharedQuotaEvidence({ root: f.root, pool: a.pool, bindings: a.bindings, config: a.quota, lease,
      evidence: { observations, unavailableWorkerIds: refresher.unavailableWorkerIds(),
        quotaUnavailableWorkerIds: refresher.quotaUnavailableWorkerIds() }, state: 'running' });
    return { observations, lease, close: async () => { await refresher.close(); lease.close(); } };
  } catch (error) { await refresher.close(); lease.close(); throw error; }
}

describe.skipIf(process.platform !== 'darwin')('independent commissioning authority boundaries', () => {
  it('preserves the original two epochs, all receipts and every operator hold while grouping personal aliases', () => {
    const f = fixture(); const before = structuredClone(f.state); const a = apply(f); const after = f.ledger();
    expect(after.configurationHistory.slice(0, 2)).toEqual(before.configurationHistory);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.allocation).toEqual(before.allocation);
    expect(after.workerAccess).toEqual(before.workerAccess);
    expect(after.quotaScopeAccess).toEqual(before.quotaScopeAccess);
    expect(a.pool).toEqual(f.active.pool);
    const personal = a.bindings.filter((binding: { capacityKey: string }) => binding.capacityKey === 'personal');
    expect(personal.map((binding: { workerId: string }) => binding.workerId).sort()).toEqual(['general', 'spark']);
    expect(personal.map((binding: { command: string[] }) => binding.command)).toEqual([f.personal.command, f.personal.command]);
    expect(existsSync(f.invoked)).toBe(false);
  });

  it.each(['journal.json', 'ready.json', 'before-pool.json', 'after-pool.json'])('withholds every ledger effect after completed %s custody is lost', async name => {
    const f = fixture(); const a = apply(f); rmSync(join(a.custody, name));
    const ledgerBefore = readFileSync(join(f.root, 'pool-state.json'));
    const operatorBefore = readFileSync(join(f.accountsRoot, 'bindings.json'));
    expect(() => resourcePoolStatus(f.root, a.pool, a.bindings, [])).toThrow();
    expect(() => setResourcePoolAllocation(f.root, a.pool, a.bindings, 65, 7)).toThrow();
    expect(() => setResourceWorkerAccess(f.root, a.pool, a.bindings, [], 4)).toThrow();
    expect(() => setResourceQuotaScopeAccess(f.root, a.pool, a.bindings, [], 3)).toThrow();
    await expect(runResourceTask({ root: f.root, pool: a.pool, bindings: a.bindings,
      observations: apparentReady(f), task: task(f, 'lost-custody-task') })).rejects.toThrow();
    expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(ledgerBefore);
    expect(readFileSync(join(f.accountsRoot, 'bindings.json'))).toEqual(operatorBefore);
    expect(existsSync(f.invoked)).toBe(false);
  });

  it('refuses a deleted ledger instead of initializing fresh state over completed commissioning custody', async () => {
    const f = fixture(); const a = apply(f); rmSync(join(f.root, 'pool-state.json'));
    expect(() => resourcePoolStatus(f.root, a.pool, a.bindings, [])).toThrow();
    await expect(runResourceTask({ root: f.root, pool: a.pool, bindings: a.bindings,
      observations: apparentReady(f), task: task(f, 'missing-ledger-task') })).rejects.toThrow();
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false); expect(existsSync(f.invoked)).toBe(false);
  });

  it('withholds admission on unknown custody-parent entries instead of overlooking them', () => {
    const f = fixture(); const a = apply(f);
    saveIndependentJson(join(f.root, 'pool-commissioning', 'unrecognized.json'), { claimed: 'ready' });
    const before = independentTree(f.base);
    expect(() => resourcePoolStatus(f.root, a.pool, a.bindings, [])).toThrow();
    expect(independentTree(f.base)).toEqual(before); expect(existsSync(f.invoked)).toBe(false);
  });

  it.each(['journal.json', 'ready.json', 'before-pool.json', 'after-pool.json'])('rejects changed completed %s without rewriting custody', name => {
    const f = fixture(); const a = apply(f); const path = join(a.custody, name);
    const corrupted = JSON.parse(readFileSync(path, 'utf8')); corrupted.schemaVersion = 999;
    saveIndependentJson(path, corrupted); const before = independentTree(f.base);
    expect(() => resourcePoolStatus(f.root, a.pool, a.bindings, [])).toThrow();
    expect(() => applyResourcePoolCommissioning({ ...f.request, expectedPlanDigest: a.plan.planDigest })).toThrow();
    expect(independentTree(f.base)).toEqual(before); expect(existsSync(f.invoked)).toBe(false);
  });

  it('does not accept fabricated fresh worker readings or caller-supplied commissioning claims', async () => {
    const f = fixture(); const a = apply(f);
    for (const observations of [apparentReady(f), apparentReady(f).map((row: Record<string, unknown>) => ({ ...row,
      commissioning: { planDigest: a.plan.planDigest, poolDigest: a.plan.targetPoolDigest,
        profileMetadataDigest: 'a'.repeat(64), profileEpochDigest: 'b'.repeat(64),
        collectorBindingDigest: 'c'.repeat(64), collectorOwner: 'd'.repeat(64) } }))]) {
      const qualification = qualifyResourceCommissioningObservations(f.root, f.ledger(), a.pool, a.bindings, observations);
      expect(qualification.quotaDenied).toContain('cmp');
      expect(qualification.observations.find(row => row.workerId === 'cmp')).toBeUndefined();
      // A validator may refuse the fake envelope or return a held plan. Neither may invoke a worker.
      let accepted = false;
      try {
        const result = await runResourceTask({ root: f.root, pool: a.pool, bindings: a.bindings,
          observations, task: task(f, observations[0]?.commissioning ? 'fake-envelope' : 'plain-fresh') });
        accepted = result.receipt !== null;
      } catch { /* Explicitly refused fake evidence. */ }
      expect(accepted).toBe(false); expect(existsSync(f.invoked)).toBe(false);
    }
  });

  it('qualifies current owned quota separately from billing, then withholds a changed auth-file epoch', async () => {
    const f = fixture(); const a = apply(f); const owned = await collector(f, a);
    try {
      const first = qualifyResourceCommissioningObservations(f.root, f.ledger(), a.pool, a.bindings, owned.observations);
      expect(first.quotaDenied).not.toContain('cmp'); expect(first.billingDenied).toContain('cmp');
      expect(first.observations.find(row => row.workerId === 'cmp')).toEqual(owned.observations.find(row => row.workerId === 'cmp'));
      const fakeBilling = owned.observations.map(row => row.workerId === 'cmp' ? { ...row, commissioning: { ...row.commissioning!,
        subscriptionOnlyBoundary: { source: 'codex-siwc-app-credit-control' as const, accountHint: 'd'.repeat(64),
          observedAt: row.observedAt, expiresAt: row.expiresAt, creditsEnabled: false as const } } } : row);
      const beforeShared = readFileSync(join(f.root, '.resource-quota-shared-evidence.json'));
      expect(() => publishSharedQuotaEvidence({ root: f.root, pool: a.pool, bindings: a.bindings, config: a.quota,
        lease: owned.lease, evidence: { observations: fakeBilling, unavailableWorkerIds: [] }, state: 'running' })).toThrow();
      expect(readFileSync(join(f.root, '.resource-quota-shared-evidence.json'))).toEqual(beforeShared);
      const altered = owned.observations.map(row => row.workerId === 'cmp' ? { ...row,
        windows: row.windows.map(window => ({ ...window, usedPercent: 0 })) } : row);
      expect(qualifyResourceCommissioningObservations(f.root, f.ledger(), a.pool, a.bindings, altered).quotaDenied).toContain('cmp');
      saveIndependentJson(join(f.cmp.nativeStatePath, 'auth.json'), { changed: 'synthetic epoch only' });
      const after = qualifyResourceCommissioningObservations(f.root, f.ledger(), a.pool, a.bindings, owned.observations);
      expect(after.quotaDenied).toContain('cmp'); expect(after.observations.find(row => row.workerId === 'cmp')).toBeUndefined();
      expect(existsSync(f.invoked)).toBe(false);
    } finally { await owned.close(); }
  });

  it('refuses a structurally valid substituted quota account hint before target collector qualification', () => {
    const f = fixture(); const a = apply(f);
    const changed = { ...a.quota, workers: a.quota.workers.map((row: { workerId: string }) => row.workerId === 'cmp'
      ? { ...row, accountHint: '9'.repeat(64) } : row) };
    saveIndependentJson(join(f.accountsRoot, 'quota-config.json'), changed);
    expect(() => qualifyResourceCommissioningObservations(f.root, f.ledger(), a.pool, a.bindings, apparentReady(f))).toThrow();
    expect(existsSync(f.invoked)).toBe(false);
  });

  it('blocks retained old-origin follow-ups while preserving the historical transcript and queued input', async () => {
    const f = fixture(); const at = new Date().toISOString();
    const queuedInput = { id: 'waiting', prompt: 'PRIVATE_OLD_QUEUE', allowedWorkerIds: ['cmp'],
      mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 128 };
    const historical = { id: 'retained-parent', state: 'settled', enqueuedAt: at, updatedAt: at,
      allowedWorkerIds: ['cmp'], mode: 'read-only', workerId: 'cmp', outcome: 'completed', reason: null,
      input: null, taskDigest: 'e'.repeat(64), retainHistory: true,
      history: { prompt: 'PRIVATE_OLD_PROMPT', output: { text: 'PRIVATE_OLD_OUTPUT', truncated: false } } };
    const queued = { id: queuedInput.id, state: 'queued', enqueuedAt: at, updatedAt: at,
      allowedWorkerIds: ['cmp'], mode: 'read-only', workerId: null, outcome: null, reason: null,
      input: queuedInput, taskDigest: digest(canonical({ ...queuedInput, schemaVersion: 1, cwd: f.workspace })) };
    saveIndependentJson(join(f.root, 'resource-console-state.json'), { schemaVersion: 5, paused: true,
      scopeDigest: digest(canonical({ pool: f.old.pool, bindings: f.old.bindings, workspace: f.workspace })),
      originPoolDigest: f.old.poolDigest, jobs: [historical, queued] });
    const a = apply(f); const afterApply = readFileSync(join(f.root, 'resource-console-state.json'));
    resourcePoolStatus(f.root, a.pool, a.bindings, []);
    const owner = await createResourcePoolSupervisor({ root: f.root, workspace: f.workspace, pool: a.pool, bindings: a.bindings,
      readObservations: () => [], readUnavailableWorkerIds: () => a.pool.workers.map((worker: { id: string }) => worker.id) });
    try {
      const history = owner.history(historical.id)!;
      expect(history).toMatchObject({ prompt: 'PRIVATE_OLD_PROMPT', output: { text: 'PRIVATE_OLD_OUTPUT', truncated: false } });
      expect(history.transcriptDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(() => owner.submit({ ...queuedInput, id: 'old-context-new-identity', prompt: 'NEW_REQUEST',
        parent: { taskId: historical.id, expectedTranscriptDigest: history.transcriptDigest } })).toThrow(/commission|enroll|context|epoch/i);
      expect(owner.snapshot().jobs.find(job => job.id === queued.id)?.state).toBe('queued');
      expect(owner.history(historical.id)).toEqual(history);
      expect(existsSync(f.invoked)).toBe(false);
    } finally { await owner.close(); }
    // An apparent current-origin parent cannot launder an older ancestor's captured text.
    const substituted = JSON.parse(afterApply.toString());
    substituted.jobs.push({ ...historical, id: 'current-looking-descendant', originPoolDigest: f.ledger().poolDigest,
      taskDigest: 'f'.repeat(64), submissionDigest: 'a'.repeat(64),
      parent: { taskId: historical.id, expectedTranscriptDigest: 'b'.repeat(64) },
      context: [{ taskId: historical.id, prompt: 'PRIVATE_OLD_PROMPT', output: { text: 'PRIVATE_OLD_OUTPUT', truncated: false }, outcome: 'completed' }],
      history: { prompt: 'NEW_REQUEST', output: { text: 'NEW_RESULT', truncated: false } } });
    expect(() => decodeResourceConsoleState(substituted, { workspace: f.workspace, pool: a.pool, bindings: a.bindings,
      configHistory: f.ledger().configurationHistory })).toThrow('Conversation context crosses commissioning boundary');
    // No newly accepted job or rewritten old private content may result from the rejected follow-up.
    expect(f.ledger().attempts).toEqual(f.state.attempts);
    expect(JSON.parse(readFileSync(join(f.root, 'resource-console-state.json'), 'utf8')).jobs)
      .toEqual(JSON.parse(afterApply.toString()).jobs);
    const laterOwner = await createResourcePoolSupervisor({ root: f.root, workspace: f.workspace, pool: a.pool, bindings: a.bindings,
      readObservations: () => [], readUnavailableWorkerIds: () => a.pool.workers.map((row: { id: string }) => row.id) });
    try {
      laterOwner.deleteHistory(historical.id); expect(laterOwner.history(historical.id)).toBeNull();
      expect(laterOwner.submit({ ...queuedInput, id: 'legitimate-new-job', prompt: 'NEW_EXPLICIT_REQUEST' }).state).toBe('queued');
    } finally { await laterOwner.close(); }
    const forgotten = readFileSync(join(f.root, 'resource-console-state.json'));
    expect(() => resourcePoolStatus(f.root, a.pool, a.bindings, [])).not.toThrow();
    expect(applyResourcePoolCommissioning({ ...f.request, expectedPlanDigest: a.plan.planDigest }).disposition).toBe('replayed');
    expect(readFileSync(join(f.root, 'resource-console-state.json'))).toEqual(forgotten);
    expect(JSON.parse(forgotten.toString()).jobs.find((row: { id: string }) => row.id === historical.id).history).toBeNull();
  });

  it('refuses a relabeled historical retained job at ordinary supervisor startup', async () => {
    const f = fixture(); const at = new Date().toISOString();
    const job = { id: 'retained-parent', state: 'settled', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['cmp'],
      mode: 'read-only', workerId: 'cmp', outcome: 'completed', reason: null, input: null,
      taskDigest: 'e'.repeat(64), retainHistory: true,
      history: { prompt: 'PRIVATE_OLD_PROMPT', output: { text: 'PRIVATE_OLD_OUTPUT', truncated: false } } };
    saveIndependentJson(join(f.root, 'resource-console-state.json'), { schemaVersion: 5, paused: true,
      scopeDigest: digest(canonical({ pool: f.old.pool, bindings: f.old.bindings, workspace: f.workspace })),
      originPoolDigest: f.old.poolDigest, jobs: [job] });
    const a = apply(f); const relabeled = JSON.parse(readFileSync(join(f.root, 'resource-console-state.json'), 'utf8'));
    relabeled.jobs[0].originPoolDigest = f.ledger().poolDigest;
    relabeled.jobs[0].taskDigest = digest(canonical({ schemaVersion: 1, id: job.id, cwd: f.workspace,
      prompt: job.history.prompt, allowedWorkerIds: ['cmp'], mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 128 }));
    saveIndependentJson(join(f.root, 'resource-console-state.json'), relabeled);
    const before = readFileSync(join(f.root, 'resource-console-state.json'));
    let owner: Awaited<ReturnType<typeof createResourcePoolSupervisor>> | undefined;
    let refused = false;
    try {
      owner = await createResourcePoolSupervisor({ root: f.root, workspace: f.workspace, pool: a.pool, bindings: a.bindings,
        readObservations: () => [], readUnavailableWorkerIds: () => a.pool.workers.map((row: { id: string }) => row.id) });
      const history = owner.history(job.id)!;
      owner.submit({ id: 'laundered-context', prompt: 'NEW_REQUEST', allowedWorkerIds: ['cmp'], mode: 'read-only',
        timeoutMs: 1000, maxOutputTokens: 128, parent: { taskId: job.id, expectedTranscriptDigest: history.transcriptDigest } });
    } catch { refused = true; } finally { await owner?.close(); }
    expect(refused).toBe(true);
    expect(readFileSync(join(f.root, 'resource-console-state.json'))).toEqual(before);
    expect(existsSync(f.invoked)).toBe(false);
  });

  it('replays completed commissioning without restoring earlier allocation, pauses or exclusions', () => {
    const f = fixture(); const a = apply(f);
    setResourcePoolAllocation(f.root, a.pool, a.bindings, 60, 7);
    setResourceWorkerAccess(f.root, a.pool, a.bindings, ['cmp', 'claude'], 4);
    const before = independentTree(f.base);
    const replay = applyResourcePoolCommissioning({ ...f.request, expectedPlanDigest: a.plan.planDigest });
    expect(replay.disposition).toBe('replayed'); expect(independentTree(f.base)).toEqual(before);
    expect(f.ledger().allocation.ceilingPercent).toBe(60); expect(existsSync(f.invoked)).toBe(false);
  });

  it('keeps local work usable and preserves its later receipt when replaying across an additive epoch', async () => {
    const f = fixture(); const a = apply(f); const local = localEpoch(f, a);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'INERT_LOCAL_RESULT' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await runResourceTask({ root: f.root, pool: local.pool, bindings: local.bindings,
      observations: [localObservation()], task: { ...task(f, 'later-local-work'), allowedWorkerIds: ['local'] } });
    expect(result.receipt?.status).toBe('completed'); expect(fetch).toHaveBeenCalledTimes(1);
    const before = independentTree(f.base);
    expect(applyResourcePoolCommissioning({ ...f.request, expectedPlanDigest: a.plan.planDigest }).disposition).toBe('replayed');
    expect(independentTree(f.base)).toEqual(before);
    expect(f.ledger().attempts.at(-1)).toEqual(result.receipt); expect(existsSync(f.invoked)).toBe(false);
  });

  it('rechecks custody after the caller precondition and before an otherwise eligible local invocation', async () => {
    const f = fixture(); const a = apply(f); const local = localEpoch(f, a);
    const fetch = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetch);
    let callbackReached = false;
    await expect(runResourceTask({ root: f.root, pool: local.pool, bindings: local.bindings,
      observations: [localObservation()], task: { ...task(f, 'callback-custody-loss'), allowedWorkerIds: ['local'] },
      beforeWorkerDispatch: () => { callbackReached = true; rmSync(join(a.custody, 'ready.json')); return true; } })).rejects.toThrow();
    expect(callbackReached).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(existsSync(f.invoked)).toBe(false);
  });
  it('resumes an interrupted real witnessed staging prefix without publishing a partial journal or touching the ledger', () => {
    const f = fixture(); const plan = checkResourcePoolCommissioning(f.request);
    const input = { ...f.request, expectedPlanDigest: plan.planDigest };
    const original = privateWrites.writePrivateFileAtomically; let stopped = false;
    vi.spyOn(privateWrites, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      if (!stopped && target.endsWith('/after-pool.json')) { stopped = true; throw new Error('independent interruption'); }
    });
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(stopped).toBe(true);
    expect(f.ledger()).toEqual(f.state);
    expect(existsSync(join(f.root, 'pool-commissioning', digest(canonical(f.request))))).toBe(false);
    vi.restoreAllMocks();
    expect(() => resumeResourcePoolCommissioning(input)).toThrow();
    expect(applyResourcePoolCommissioning(input).status).toBe('applied');
    expect(f.ledger().attempts).toEqual(f.state.attempts); expect(existsSync(f.invoked)).toBe(false);
  });

  it('holds a substituted earlier config before ready publication and resumes the exact approved transition', () => {
    const f = fixture(); const plan = checkResourcePoolCommissioning(f.request);
    const input = { ...f.request, expectedPlanDigest: plan.planDigest };
    const beforePool = readFileSync(join(f.accountsRoot, 'pool.json'));
    const original = privateWrites.writePrivateFileAtomically; let substituted = false;
    vi.spyOn(privateWrites, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      if (!substituted && target === join(f.accountsRoot, 'bindings.json')) {
        substituted = true; writeFileSync(join(f.accountsRoot, 'pool.json'), beforePool);
      }
    });
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(substituted).toBe(true);
    expect(f.ledger().pendingEvolution).toBeDefined();
    expect(existsSync(join(f.root, 'pool-commissioning', digest(canonical(f.request)), 'ready.json'))).toBe(false);
    expect(() => resourcePoolStatus(f.root, f.currentPool(), f.currentBindings(), [])).toThrow();
    vi.restoreAllMocks();
    expect(resumeResourcePoolCommissioning(input).disposition).toBe('resumed');
    expect(f.currentPool()).toEqual(f.active.pool); expect(f.ledger().attempts).toEqual(f.state.attempts);
    expect(existsSync(f.invoked)).toBe(false);
  });

  it('refuses a structurally valid substituted completed operator configuration without resetting it', () => {
    const f = fixture(); const a = apply(f);
    const changed = { ...a.pool, workers: a.pool.workers.map((row: {id: string; maxConcurrent: number}) =>
      row.id === 'cmp' ? { ...row, maxConcurrent: row.maxConcurrent + 1 } : row) };
    saveIndependentJson(join(f.accountsRoot, 'pool.json'), changed);
    const before = independentTree(f.base);
    expect(() => resourcePoolStatus(f.root, changed, a.bindings, [])).toThrow();
    expect(() => resumeResourcePoolCommissioning({ ...f.request, expectedPlanDigest: a.plan.planDigest })).toThrow();
    expect(independentTree(f.base)).toEqual(before); expect(existsSync(f.invoked)).toBe(false);
  });

  it('inherits quota and billing holds for a later additive native alias on commissioned capacity', async () => {
    const f = fixture(); const a = apply(f);
    const originalWorker = a.pool.workers.find((row: {id: string}) => row.id === 'cmp');
    const originalBinding = a.bindings.find((row: {workerId: string}) => row.workerId === 'cmp');
    const pool = { ...a.pool, workers: [...a.pool.workers, { ...originalWorker, id: 'cmp-alias' }] };
    const bindings = [...a.bindings, { ...originalBinding, workerId: 'cmp-alias' }];
    const options = { root: f.root, workspace: f.workspace, pool: a.pool, bindings: a.bindings, nextPool: pool, nextBindings: bindings };
    const plan = checkResourcePoolEvolution(options);
    applyResourcePoolEvolution({ ...options, expectedPlanDigest: plan.planDigest });
    const current = resourcePoolConfigSnapshot(pool, bindings);
    saveIndependentJson(join(f.accountsRoot, 'pool.json'), current.pool);
    saveIndependentJson(join(f.accountsRoot, 'bindings.json'), current.bindings);
    saveIndependentJson(join(f.accountsRoot, 'quota-config.json'), { ...a.quota, poolDigest: current.poolDigest,
      workers: [...a.quota.workers, { ...a.quota.workers.find((row: {workerId: string}) => row.workerId === 'cmp'), workerId: 'cmp-alias' }] });
    const reading = { ...apparentReady(f).find((row: {workerId: string}) => row.workerId === 'cmp')!, workerId: 'cmp-alias' };
    const qualification = qualifyResourceCommissioningObservations(f.root, f.ledger(), current.pool, current.bindings, [reading]);
    expect(qualification.quotaDenied).toContain('cmp-alias'); expect(qualification.billingDenied).toContain('cmp-alias');
    const result = await runResourceTask({ root: f.root, pool: current.pool, bindings: current.bindings, observations: [reading],
      task: { ...task(f, 'new-alias-inherits-holds'), allowedWorkerIds: ['cmp-alias'] } });
    expect(result.receipt).toBeNull(); expect(existsSync(f.invoked)).toBe(false);
  });

  it('rechecks prior completed custody before every later additive publication', () => {
    const f = fixture(); const a = apply(f); const beforeLedger = readFileSync(join(f.root, 'pool-state.json'));
    const pool = { ...a.pool, workers: [...a.pool.workers, { id: 'local', provider: 'local', model: 'inert-review',
      maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 20, taskWindowMs: 60_000, priority: 1 }] };
    const bindings = [...a.bindings, { workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }];
    const options = { root: f.root, workspace: f.workspace, pool: a.pool, bindings: a.bindings, nextPool: pool, nextBindings: bindings };
    const plan = checkResourcePoolEvolution(options); const original = privateWrites.writePrivateFileAtomically;
    let custodyLost = false; const publicationsAfterLoss: string[] = [];
    vi.spyOn(privateWrites, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, writeOptions) => {
      if (custodyLost) publicationsAfterLoss.push(target);
      original(temporary, target, bytes, writeOptions);
      if (!custodyLost && target.includes('/pool-evolution/') && target.endsWith('/journal.json')) {
        custodyLost = true; rmSync(join(a.custody, 'ready.json'));
      }
    });
    let refused = false;
    try { applyResourcePoolEvolution({ ...options, expectedPlanDigest: plan.planDigest }); } catch { refused = true; }
    expect(custodyLost).toBe(true); expect(refused).toBe(true); expect(publicationsAfterLoss).toEqual([]);
    expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(beforeLedger);
    expect(existsSync(f.invoked)).toBe(false);
  });

  it('keeps the barrier when newly published ready custody disappears before terminal ledger publication', () => {
    const f = fixture(); const plan = checkResourcePoolCommissioning(f.request);
    const input = { ...f.request, expectedPlanDigest: plan.planDigest };
    const original = privateWrites.writePrivateFileAtomically; let readyLost = false;
    vi.spyOn(privateWrites, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      if (!readyLost && target.endsWith('/ready.json')) { readyLost = true; rmSync(target); }
    });
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(readyLost).toBe(true);
    expect(f.ledger().pendingEvolution).toBeDefined();
    expect(f.ledger().attempts).toEqual(f.state.attempts); expect(existsSync(f.invoked)).toBe(false);
  });

});


// A controlled capture port isolates metadata invalidation from native process custody.
// No witnessed profile, subprocess, provider, or lease marker is created by these cases.
describe('independent collector settlement boundaries', () => {
  it.each(['before-contact', 'after-settlement', 'unknown-launch'] as const)('preserves process facts for %s capture failure', async phase => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'commissioning-capture-port-')));
    const pool = { schemaVersion: 1 as const, id: 'quota-lifecycle', workers: [{ id: 'cmp', provider: 'codex' as const,
      model: 'inert', maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 20, taskWindowMs: 60_000, priority: 1 }] };
    const bindings = [{ workerId: 'cmp', capacityKey: 'cmp', kind: 'native-cli' as const, command: [process.execPath, join(root, 'never-invoked.mjs')] }];
    const config = { schemaVersion: 1 as const, poolDigest: resourcePoolConfigSnapshot(pool, bindings).poolDigest,
      workers: [{ workerId: 'cmp', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] };
    let captureCalls = 0;
    vi.spyOn(commissioningEvidence, 'captureResourceCommissioningObservation').mockImplementation(() => {
      captureCalls++;
      if (phase === 'before-contact' || phase === 'after-settlement' && captureCalls === 2) throw new Error('read-only capture invalidated');
      return null;
    });
    const settled = vi.fn(); const coordinator = createNativeMetadataCoordinator({ beginNativeActivity: () => ({ settle: settled }) });
    const probe = vi.fn(async options => {
      if (phase === 'unknown-launch') throw new Error('unknown native launch outcome');
      const now = Date.now(); const observedAt = new Date(now).toISOString();
      return { schemaVersion: 1 as const, scope: 'codex-native-metadata' as const, workerId: options.workerId,
        poolDigest: config.poolDigest, status: 'observed' as const, reason: 'synthetic-settled', startedAt: observedAt,
        finishedAt: observedAt, accountHint: options.expectedAccountHint, planType: null,
        cleanupDiagnostics: { processGroupSettlement: 'group-exit-confirmed' as const, timedOut: false, cancelled: false },
        observation: { workerId: 'cmp', observedAt, expiresAt: new Date(now + 60_000).toISOString(), health: 'ready' as const,
          retryAfter: null, windows: [{ id: 'codex_codex_primary', usedPercent: 5, resetsAt: new Date(now + 3_600_000).toISOString() }] } };
    });
    const refresher = createResourceQuotaRefresher({ pool, bindings, config, cwd: root, coordinator, _probe: probe });
    let closeFailure: unknown;
    try {
      await vi.waitFor(() => expect(refresher.snapshot().workers[0]?.status).not.toMatch(/pending|refreshing/));
      const row = refresher.snapshot().workers[0]!;
      if (phase === 'unknown-launch') {
        expect(row.status).toBe('uncertain'); expect(settled).not.toHaveBeenCalled(); expect(coordinator.signal.aborted).toBe(true);
      } else {
        expect(row.status).not.toBe('uncertain'); expect(settled).toHaveBeenCalledTimes(1);
        expect(refresher.readObservations([])).toEqual([]);
      }
      expect(probe).toHaveBeenCalledTimes(phase === 'before-contact' ? 0 : 1);
    } finally {
      try { await refresher.close(); } catch (error) { closeFailure = error; }
      coordinator.dispose(); rmSync(root, { recursive: true, force: true });
    }
    if (phase === 'unknown-launch') expect(String(closeFailure)).toContain('termination unconfirmed');
    else expect(closeFailure).toBeUndefined();
  });
});
