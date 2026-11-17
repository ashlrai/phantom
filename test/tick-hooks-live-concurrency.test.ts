import { afterEach, expect, it, vi } from 'vitest';
import { createLiveTickHooks, type LiveHooksDeps } from '../src/core/fleet/tick-hooks-live.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { emptyBackpressureState } from '../src/core/fleet/backpressure.js';
import type { EffectivePolicy, LedgerEntry } from '../src/core/authority/types.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const REPO = 'ashlrai/binshield';
const PATH = '/tmp/mirrors/ashlrai__binshield';
const cfg = { foundry: { allowedBackends: ['builtin'] }, devin: { enabled: true, fleet: true } } as AshlrConfig;
const hookCtx = { nowMs: NOW, cfg, dryRun: false, capabilityKind: 'resident-standing' as const };

function fixture() {
  const policy = {
    v: 1, grantId: 'g-1', grantSeq: 1, keyId: 'k', issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString(),
    switch: 'autonomous', rollout: { stageId: '2b', stageIndex: 2, stageCount: 5, enteredAt: new Date(NOW).toISOString() },
    repos: [{ nameWithOwner: REPO, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null }],
    merge: { maxFiles: 4, maxLines: 150, selfRepo: 'propose-only', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
    spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats: {} }, engines: ['local'], leader: { classes: ['A'], vetoMinutes: 30 }, conductorGoals: false, computedAt: new Date(NOW).toISOString(),
  } as EffectivePolicy;
  const audits: string[] = [];
  const deps: Partial<LiveHooksDeps> = {
    now: () => NOW, killActive: () => false,
    standingPolicy: () => policy, applyOverlay: c => c, liveLeaderConfig: c => c,
    clampBudget: p => p, loadBudget: () => defaultBudgetPolicy(), capacitySnapshot: () => null,
    listEnrolled: () => [PATH], repoIdentity: () => REPO,
    sweepHolds: () => ({ swept: 0, error: null }), listHolds: () => [],
    prepareMirrors: async () => ({ ready: [{ nameWithOwner: REPO, path: PATH, base: 'main', headSha: 'a'.repeat(40) }], failed: [], pausedRepoPaths: [] }),
    reconcileEnrollment: async () => ({ changed: false, enrolled: [], unenrolled: [], errors: [] }),
    ingestCloudPrs: async () => ({ checked: 0, ingested: 0, superseded: 0, refused: 0, deferred: 0, killed: false, outcomes: [] }),
    launchDevinFleet: async () => ({ outcome: 'held', reason: 'test', code: 'budget', repo: null, itemId: null, taskId: null }),
    leaderTick: async () => undefined,
    readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    readJournalSince: async () => [], waitingVerify: async () => 0, ledgerHead: () => null,
    observeFleetPrs: async () => new Map(), loadBackpressure: () => emptyBackpressureState(), saveBackpressure: () => undefined,
    advanceWatch: async () => ({ ok: true, reason: null, open: 0, finalized: [], reverted: [], escalations: [], softKilled: false, suiteRuns: 0, discovered: 0 }),
    probeLocalRuntime: async () => ({ reachable: false, slots: 0, busySlots: 0, idleSlots: 0, observedAt: new Date(NOW).toISOString(), contextPerSlot: null, detail: 'test' }),
    presence: async () => ({ present: false, reason: 'test', evidenceAt: null }), directives: () => null,
    installed: () => false, tierOf: () => 'local', localFleetEngine: () => null,
    insights: async () => [], enqueueInsights: () => 0, releaseTasks: () => 0, readTasks: () => ({ ok: true, tasks: [] }),
    syncReleaseArticles: async () => undefined, writeTick: () => true, appendJournal: () => true,
    audit: entry => { audits.push(entry.summary); }, checkCanary: () => undefined,
    overnightActive: () => false,
  };
  return { deps, audits };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

it('overlaps Leader with intake then Devin, waiting for both before evidence', async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const { deps } = fixture();
  const intake = deferred<void>(); const leader = deferred<void>(); const devin = deferred<void>();
  const intakeStarted = deferred<void>(); const leaderStarted = deferred<void>(); const devinStarted = deferred<void>();
  const events: string[] = [];
  const intakeResult = deps.ingestCloudPrs!; const devinResult = deps.launchDevinFleet!;
  deps.ingestCloudPrs = async (...args) => { events.push('intake'); intakeStarted.resolve(); await intake.promise; events.push('intake-done'); return intakeResult(...args); };
  deps.leaderTick = async () => { events.push('leader'); leaderStarted.resolve(); await leader.promise; };
  deps.launchDevinFleet = async (...args) => { events.push('devin'); devinStarted.resolve(); await devin.promise; return devinResult(...args); };
  deps.readLedger = vi.fn(deps.readLedger);
  const tick = createLiveTickHooks({ deps }).beforeTick(hookCtx);
  await Promise.all([intakeStarted.promise, leaderStarted.promise]);
  expect(events).not.toContain('devin');
  await vi.advanceTimersByTimeAsync(20);
  intake.resolve();
  await devinStarted.promise;
  expect(events.indexOf('intake-done')).toBeLessThan(events.indexOf('devin'));
  await vi.advanceTimersByTimeAsync(5);
  leader.resolve();
  expect(deps.readLedger).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5);
  devin.resolve(); await tick;
  expect(deps.readLedger).toHaveBeenCalledTimes(1);
  expect(Date.now() - startedAt).toBe(Math.max(20 + 10, 25));
});

it.each(['failed', 'timed-out'] as const)('continues while a %s Leader does not hold the tick', async kind => {
  vi.useFakeTimers();
  const { deps, audits } = fixture();
  const started = deferred<void>(); const hanging = deferred<void>();
  deps.leaderTick = async () => { started.resolve(); if (kind === 'failed') throw new Error('leader unavailable'); await hanging.promise; };
  const tick = createLiveTickHooks({ deps, leaderTimeoutMs: 15 }).beforeTick(hookCtx);
  await started.promise;
  await vi.advanceTimersByTimeAsync(15);
  await tick;
  expect(audits.some(message => message.includes(kind === 'failed' ? 'the Leader tick failed: leader unavailable' : 'the Leader tick exceeded 15 ms'))).toBe(true);
  hanging.resolve();
});

it.each([false, true])('reads evidence concurrently and observes PRs only after ledger (failure: %s)', async failure => {
  const { deps } = fixture();
  const ledger = deferred<void>(); const journal = deferred<void>(); const waiting = deferred<void>();
  const started = [deferred<void>(), deferred<void>(), deferred<void>()];
  deps.readLedger = async () => { started[0]!.resolve(); await ledger.promise; if (failure) throw new Error('ledger unavailable'); return { entries: [{ kind: 'pr:opened', at: new Date(NOW).toISOString(), data: { repo: REPO, number: 1, proposalId: 'p1' } } as LedgerEntry], head: null, chain: 'ok', brokenAtSeq: null, reason: null }; };
  deps.readJournalSince = async () => { started[1]!.resolve(); await journal.promise; if (failure) throw new Error('journal unavailable'); return []; };
  deps.waitingVerify = async () => { started[2]!.resolve(); await waiting.promise; if (failure) throw new Error('queue unavailable'); return 0; };
  deps.observeFleetPrs = vi.fn(async () => new Map());
  const tick = createLiveTickHooks({ deps }).beforeTick(hookCtx);
  await Promise.all(started.map(stage => stage.promise));
  journal.resolve(); waiting.resolve();
  expect(deps.observeFleetPrs).not.toHaveBeenCalled();
  ledger.resolve(); const result = await tick;
  expect(deps.observeFleetPrs).toHaveBeenCalledTimes(failure ? 0 : 1);
  if (failure) expect(result.holdProduction).toContain('ledger');
});
