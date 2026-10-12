/** Offline routing receipts under explicit temporary private roots. No live clients or keys. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutingLab, routingLabFixtureCorpus } from '../src/core/proactive/routing-lab.js';
import { companionDigest } from '../src/core/proactive/coordination-types.js';
import { projectCompanionWire } from '../src/core/proactive/coordination-wire.js';
import { reserveReplayWatermark } from '../src/core/proactive/replay-watermark.js';
import type { OfflineChoiceAdapter, OfflineChoicePayload, RoutingLabCommand, RoutingLabTask, RoutingLabWrite } from '../src/core/proactive/routing-lab-types.js';
import type { ProactiveResourceEvidenceResponse } from '../src/core/proactive/resource-evidence-types.js';

const AT = '2026-10-12T12:00:00.000Z';
let root: string, directory: string;
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'phantom-routing-lab-')); directory = join(root, 'lab'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function good(write: RoutingLabWrite): Extract<RoutingLabWrite, { ok: true }> {
  expect(write).toMatchObject({ ok: true, executionAuthorized: false }); if (!write.ok) throw new Error(write.reason); return write;
}
function task(): RoutingLabTask { return structuredClone(routingLabFixtureCorpus(AT)[0]!.task); }
function resources(): ProactiveResourceEvidenceResponse { return structuredClone(routingLabFixtureCorpus(AT)[0]!.snapshot); }
const benchmark = (requestId = 'benchmark', expectedRevision = 0): RoutingLabCommand => ({ kind: 'benchmark', requestId, expectedRevision });
describe('durable offline/shadow routing lab', { timeout: 15_000 }, () => {
  it('runs static multi-provider/account/local/subscription/API corpus with honest fixture coverage', async () => {
    const lab = createRoutingLab({ directory, now: () => new Date(AT) });
    expect(lab.list()).toMatchObject({ sourceState: 'missing', evaluations: [], revision: 0 });
    const result = good(await lab.execute(benchmark())); const evaluation = result.evaluation!;
    expect(evaluation).toMatchObject({ status: 'completed', mode: 'fixture', adapterMode: 'offline-fixture', modelId: 'jev-1.13.0',
      providerLatencyMs: null, summary: { total: 16, evaluated: 16, expected: 16, passed: 16, failed: 0, coverage: 1 }, executionAuthorized: false });
    expect(evaluation.cases.every(item => item.executionAuthorized === false && item.providerLatencyMs === null)).toBe(true);
    const reasons = evaluation.cases.map(item => item.fallbackReason);
    expect(reasons).toEqual(expect.arrayContaining(['429', '529', 'timeout', 'below-advisory-threshold', 'out-of-vocabulary-or-malformed', 'choice-cardinality']));
    expect(evaluation.cases.find(item => item.caseId === 'deterministic')?.selectedResourceId)
      .toBe(evaluation.cases.find(item => item.caseId === 'option-order')?.selectedResourceId);
    expect(evaluation.notes.join(' ')).toContain('not calibrated correctness');
    expect(evaluation.localDurationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(projectCompanionWire(evaluation))).toContain('sha256:');
  });
  it('exact request replay is deterministic across restart and conflicting reuse is refused', async () => {
    const lab = createRoutingLab({ directory, now: () => new Date(AT) }); const original = good(await lab.execute(benchmark()));
    const choose = vi.fn(); const fresh = createRoutingLab({ directory, adapter: { mode: 'offline-fixture', choose } });
    expect(good(await fresh.execute(benchmark())).evaluation).toEqual(original.evaluation);
    expect(choose).not.toHaveBeenCalled(); expect(fresh.list().revision).toBe(2);
    expect(fresh.replay({ ...benchmark(), expectedRevision: 1 })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await fresh.execute({ kind: 'preview', requestId: 'benchmark', expectedRevision: 0, task: task() })).toMatchObject({ ok: false, reason: 'conflict' });
  });
  it('shadow mode never calls injected fixture adapter or claims actual connection/project authority', async () => {
    const choose = vi.fn(async () => { throw new Error('Must not receive actual data'); }); const snapshot = resources();
    snapshot.resources[0]!.resourceId = 'native:generic-alpha:client%40example.test:agents%2FAshlr';
    snapshot.resources[0]!.identity.accountId = 'client@example.test'; snapshot.resources[0]!.identity.agentId = 'agents/Ashlr';
    snapshot.resources[3]!.resourceId = 'seat:generic-local::local%3Aqwen';
    const input = { ...task(), accountRefs: [], allowedDestination: { provider: 'generic-alpha', accountId: 'client@example.test', agentId: 'agents/Ashlr' } };
    const lab = createRoutingLab({ directory, now: () => new Date(AT), resources: () => snapshot, adapter: { mode: 'offline-fixture', choose } });
    const result = good(await lab.execute({ kind: 'preview', requestId: 'preview', expectedRevision: 0, task: input }));
    expect(result.evaluation).toMatchObject({ status: 'completed', mode: 'shadow-readonly', adapterMode: 'deterministic-only' });
    expect(result.evaluation!.cases[0]).toMatchObject({ path: 'held', selectedResourceId: null, passed: null });
    const matched = result.evaluation!.cases[0]!.candidates.find(row => row.resourceId.startsWith('native:'))!;
    expect(matched.qualification).toBe('planning-candidate'); expect(matched.holds).toContain('project-authority-unqualified');
    expect(matched.holds).not.toContain('destination-scope-mismatch');
    expect(result.evaluation!.cases[0]!.candidates.find(row => row.resourceId.startsWith('seat:'))?.holds).toContain('destination-scope-mismatch');
    expect(choose).not.toHaveBeenCalled(); expect(createRoutingLab({ directory }).list().sourceState).toBe('healthy');
  });
  it('source references never grant destination scope, and empty requested capabilities remain explicit unknown holds', async () => {
    const input = { ...task(), capabilityIds: [], allowedDestination: { provider: 'generic-alpha', accountId: 'fixture-alpha-a', agentId: 'fixture-agent' } };
    const lab = createRoutingLab({ directory, now: () => new Date(AT), resources });
    const result = good(await lab.execute({ kind: 'preview', requestId: 'generic-empty', expectedRevision: 0, task: input }));
    expect(result.evaluation!.cases[0]!.candidates.every(row => row.holds.includes('requirements-unknown'))).toBe(true);
    expect(result.evaluation!.cases[0]!.candidates.find(row => row.resourceId === 'alpha-b')?.holds).toContain('destination-scope-mismatch');
    expect(result.evaluation!.cases[0]!.selectedResourceId).toBeNull();
  });
  it('binds resolved task and source snapshot while replaying external taskId before a disappeared brief resolver', async () => {
    const resolveTask = vi.fn(() => task()); const snapshot = resources();
    const lab = createRoutingLab({ directory, now: () => new Date(AT), resources: () => snapshot, resolveTask });
    const command: RoutingLabCommand = { kind: 'preview', requestId: 'external-task', expectedRevision: 0, taskId: 'saved-task' };
    const receipt = good(await lab.execute(command)).evaluation!;
    expect(receipt.inputDigest).not.toBe(companionDigest(command)); expect(receipt.cases[0]?.taskDigest).toBe(companionDigest(task()));
    const gone = vi.fn(() => null); const readSources = vi.fn(() => { throw new Error('Gone'); });
    const fresh = createRoutingLab({ directory, resolveTask: gone, resources: readSources });
    expect(good(await fresh.execute(command)).evaluation).toEqual(receipt); expect(gone).not.toHaveBeenCalled(); expect(readSources).not.toHaveBeenCalled();
    expect(await fresh.execute({ ...command, requestId: 'missing-new', expectedRevision: 2 })).toMatchObject({ ok: false, reason: 'held' });
  });
  it('missing/invalid snapshots, unknown budget, passed deadline, and stale evidence remain visible holds', async () => {
    const snapshot = resources(); snapshot.resources[0]!.evidenceState = 'stale'; snapshot.resources[1]!.cost.value = null;
    const lab = createRoutingLab({ directory, now: () => new Date(AT), resources: () => snapshot });
    const input = { ...task(), deadline: AT, maxCostUsd: null };
    const result = good(await lab.execute({ kind: 'preview', requestId: 'holds', expectedRevision: 0, task: input }));
    const holds = result.evaluation!.cases[0]!.candidates.flatMap(row => row.holds);
    expect(holds).toEqual(expect.arrayContaining(['deadline-passed', 'budget-unknown', 'source-stale-or-unknown', 'cost-unknown-or-incomparable']));
    const missing = good(await createRoutingLab({ directory: join(root, 'missing'), now: () => new Date(AT) }).execute({ kind: 'preview', requestId: 'missing', expectedRevision: 0, task: task() }));
    expect(missing.evaluation!.cases[0]!.fallbackReason).toBe('source-missing');
    const invalid = good(await createRoutingLab({ directory: join(root, 'invalid'), now: () => new Date(AT), resources: () => ({ ...snapshot, executionAuthorized: true } as unknown as ProactiveResourceEvidenceResponse) })
      .execute({ kind: 'preview', requestId: 'invalid', expectedRevision: 0, task: task() }));
    expect(invalid.evaluation!.cases[0]).toMatchObject({ selectedResourceId: null, fallbackReason: 'source-invalid' });
  });
  it.each([
    { garbage: 0.9 }, { c0: -1 }, { c0: Infinity }, { c0: 0 }, { c0: 0.8, c999: 0.2 }, { c0: 'bad' },
  ])('malformed/OOV probability data falls back without automatic retries: %j', async probabilities => {
    const choose = vi.fn(async () => ({ ok: true, answers: { resource_choice: { type: 'choice', choice: 'c0', confidence: 0.99, probabilities } } }));
    const lab = createRoutingLab({ directory, now: () => new Date(AT), adapter: { mode: 'offline-fixture', choose } });
    const result = good(await lab.execute(benchmark()));
    expect(result.evaluation!.cases.find(item => item.caseId === 'valid-closed-choice')).toMatchObject({
      path: 'deterministic', selectedResourceId: 'local-model', fallbackReason: 'out-of-vocabulary-or-malformed', passed: false });
    expect(choose).toHaveBeenCalledTimes(7);
  });
  it('only synthetic ordinals reach the adapter; 429/529 responses fall back once per case', async () => {
    const payloads: OfflineChoicePayload[] = []; const adapter: OfflineChoiceAdapter = { mode: 'offline-fixture', choose: async payload => {
      payloads.push(payload); return { ok: false, reason: payloads.length % 2 ? '429' : '529' };
    } };
    const result = good(await createRoutingLab({ directory, now: () => new Date(AT), adapter }).execute(benchmark()));
    expect(payloads).toHaveLength(7); expect(JSON.stringify(payloads)).not.toMatch(/fixture-alpha|fixture-beta|accountId|packetDigest|tenantId/);
    expect(payloads.every(payload => payload.mode === 'offline-fixture' && Object.keys(payload.questions.resource_choice.criteria).every(key => /^c\d+$/.test(key)))).toBe(true);
    expect(result.evaluation!.cases.some(item => item.fallbackReason === '429')).toBe(true); expect(result.evaluation!.cases.some(item => item.fallbackReason === '529')).toBe(true);
  });
  it('accessor-bearing fixture response is rejected as malformed without evaluating the getter', async () => {
    const getter = vi.fn(() => { throw new Error('untrusted getter'); });
    const response = { ok: true, get answers() { return getter(); } };
    const choose = vi.fn(async () => response);
    const result = good(await createRoutingLab({ directory, now: () => new Date(AT), adapter: { mode: 'offline-fixture', choose } }).execute(benchmark()));
    expect(getter).not.toHaveBeenCalled();
    expect(result.evaluation!.cases.find(item => item.caseId === 'valid-closed-choice')).toMatchObject({ path: 'deterministic', fallbackReason: 'out-of-vocabulary-or-malformed' });
    expect(result.evaluation?.status).toBe('completed');
  });
  it('API product funding cannot fund native coding; grant receipts and funding-only pools are not executable balances', async () => {
    const snapshot = resources();
    snapshot.resources[0]!.credits[0]!.eligibleSurfaces = ['api'];
    snapshot.resources[2]!.credits[0]!.recordKind = 'grant'; snapshot.resources[2]!.credits[0]!.receiptAmount = '50';
    const pool = structuredClone(snapshot.resources[0]!); pool.resourceId = 'hypothetical-funding-pool'; pool.kind = 'funding-pool'; snapshot.resources.push(pool);
    const lab = createRoutingLab({ directory, now: () => new Date(AT), resources: () => snapshot });
    const result = good(await lab.execute({ kind: 'preview', requestId: 'funding-products', expectedRevision: 0, task: task() }));
    const rows = result.evaluation!.cases[0]!.candidates;
    expect(rows.find(row => row.resourceId === 'alpha-a')?.holds).toContain('funding-unknown-or-expired');
    expect(rows.find(row => row.resourceId === 'beta-api')?.holds).toContain('funding-unknown-or-expired');
    expect(rows.find(row => row.resourceId === pool.resourceId)).toMatchObject({ qualification: 'held', holds: expect.arrayContaining(['funding-only-not-execution-resource']) });
  });
  it('saves uncertain intent before adapter and cancellation settles aborted without replaying interrupted work', async () => {
    let entered!: () => void; const seen = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
    const adapter: OfflineChoiceAdapter = { mode: 'offline-fixture', choose: async () => { calls += 1; entered(); return new Promise(() => {}); } };
    const controller = new AbortController(); const lab = createRoutingLab({ directory, now: () => new Date(AT), adapter });
    const pending = lab.execute(benchmark(), { signal: controller.signal }); await seen;
    expect(lab.list().evaluations[0]?.status).toBe('uncertain');
    const replay = good(lab.replay(benchmark())!); expect(replay.evaluation?.status).toBe('uncertain'); expect(calls).toBe(1);
    const conflict = await lab.execute(benchmark('parallel', 0)); expect(conflict).toMatchObject({ ok: false, reason: 'conflict' });
    controller.abort(); const done = good(await pending); expect(done.evaluation?.status).toBe('aborted');
    expect(done.evaluation!.summary.coverage).toBeLessThan(1);
    expect(good(await lab.execute(benchmark())).evaluation).toEqual(done.evaluation); expect(calls).toBe(1);
  });
  it('timeout remains bounded and invalid time budget publishes no intent', async () => {
    const choose = vi.fn(async () => new Promise(() => {}));
    const lab = createRoutingLab({ directory, now: () => new Date(AT), adapter: { mode: 'offline-fixture', choose } });
    expect(await lab.execute(benchmark('bad'), { timeBudgetMs: 0 })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(lab.list().sourceState).toBe('missing');
    const result = good(await lab.execute(benchmark(), { timeBudgetMs: 10 }));
    expect(result.evaluation?.status).toBe('aborted'); expect(result.evaluation!.cases.some(item => item.fallbackReason === 'timeout')).toBe(true);
    expect(choose).toHaveBeenCalledTimes(1); expect(result.evaluation?.providerLatencyMs).toBeNull();
  });
  it('preference changes are inspectable local proposals, withdrawable without applying live policy', async () => {
    let clock = AT; const lab = createRoutingLab({ directory, now: () => new Date(clock) }); const evaluation = good(await lab.execute(benchmark())).evaluation!;
    const proposed = good(await lab.execute({ kind: 'propose-preference', requestId: 'proposal', expectedRevision: 2,
      evaluationId: evaluation.id, resourceId: 'alpha-a', reason: 'Consider this synthetic option for a future comparison.' })).proposal!;
    expect(proposed).toMatchObject({ state: 'proposed', executionAuthorized: false });
    clock = '2026-10-12T12:01:00.000Z'; const withdrawn = good(await lab.execute({ kind: 'withdraw-preference', requestId: 'withdraw', expectedRevision: 3, proposalId: proposed.id })).proposal!;
    clock = '2026-10-12T12:02:00.000Z'; const repeated = good(await lab.execute({ kind: 'withdraw-preference', requestId: 'withdraw-again', expectedRevision: 4, proposalId: proposed.id })).proposal!;
    expect(repeated.withdrawnAt).toBe(withdrawn.withdrawnAt); expect(lab.list().sourceState).toBe('healthy');
    expect(lab.list().evaluations[0]).toEqual(evaluation);
  });
  it('rejects corruption, symlink and public storage without overwriting original receipts', async () => {
    const lab = createRoutingLab({ directory, now: () => new Date(AT) }); good(await lab.execute(benchmark()));
    const records = join(directory, 'ledger', 'records'); const file = join(records, readdirSync(records)[0]!); const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('companion-routing-lab-v1', 'tampered-routing-policy'), { mode: 0o600 });
    expect(lab.list().sourceState).toBe('degraded'); expect(await lab.execute(benchmark('after-corrupt', 2))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(readFileSync(file, 'utf8')).toContain('tampered-routing-policy'); writeFileSync(file, original);
    rmSync(file); symlinkSync(join(root, 'outside'), file); expect(lab.list().sourceState).toBe('degraded');
    rmSync(file); writeFileSync(file, original, { mode: 0o600 }); chmodSync(directory, 0o755); expect(lab.list().sourceState).toBe('degraded');
  });
  it.each(['settled-only', 'entire-ledger', 'watermark-only'])('refuses truncated ledger replay without re-invoking the adapter: %s', async removal => {
    const choose = vi.fn(async () => ({ ok: false, reason: '429' }));
    const lab = createRoutingLab({ directory, now: () => new Date(AT), adapter: { mode: 'offline-fixture', choose } });
    good(await lab.execute(benchmark())); expect(choose).toHaveBeenCalledTimes(7);
    const records = join(directory, 'ledger', 'records'); const files = readdirSync(records).sort();
    if (removal === 'watermark-only') rmSync(join(directory, 'replay-watermarks'), { recursive: true });
    else for (const file of removal === 'settled-only' ? files.slice(-1) : files) rmSync(join(records, file));
    expect(lab.list().sourceState).toBe('degraded');
    expect(await lab.execute(benchmark())).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await lab.execute(benchmark('new-after-delete', 0))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(choose).toHaveBeenCalledTimes(7);
  });
  it('a reserved head without its ledger record is uncertain custody, never a fresh evaluation', async () => {
    const choose = vi.fn(async () => ({ ok: false, reason: '429' }));
    const lab = createRoutingLab({ directory, now: () => new Date(AT), adapter: { mode: 'offline-fixture', choose } });
    good(await lab.execute(benchmark()));
    const records = join(directory, 'ledger', 'records'); const last = JSON.parse(readFileSync(join(records, readdirSync(records).sort().at(-1)!), 'utf8'));
    expect(reserveReplayWatermark(directory, { revision: 3, ledgerDigest: 'f'.repeat(64), previousLedgerDigest: last.digest })).toBe('recorded');
    expect(lab.list().sourceState).toBe('degraded'); expect(await lab.execute(benchmark())).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(choose).toHaveBeenCalledTimes(7);
  });
});
