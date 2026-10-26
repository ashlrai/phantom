/** Private inert stores only: interrupted publication and finished historical replay. */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyResourcePoolCommissioning, checkResourcePoolCommissioning, resumeResourcePoolCommissioning } from '../src/core/resources/pool-commissioning.js';
import { commissioningHash } from '../src/core/resources/pool-commissioning-custody.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import { decodeResourcePoolState, resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { pinResourceConsoleProject } from '../src/core/resources/console-projects.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as writes from '../src/core/util/private-file-write.js';
import * as native from '../src/core/resources/native-profile.js';
import { independentCommissioningFixture as fixture, saveIndependentJson as save, independentTree as tree } from './support/pool-commissioning-transaction-fixture.js';
const roots: ReturnType<typeof fixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of roots.splice(0)) f.cleanup(); });
function setup() {
  const f = fixture(false); roots.push(f);
  // Private protocol fixtures prepare the profile files. Reads use this
  // fixture-only metadata port; no provider process is ever launched.
  vi.spyOn(native, 'resolveNativeSeatLaunch').mockImplementation(options => {
    const row = f.roster.accounts.find(a => a.id === options.seatId && a.provider === options.provider);
    const p = [f.personal, f.cmp, f.claude].find(profile => profile.command[1] === row?.command[1]);
    if (!row || !p) return { ok: false, reason: 'no-seat', detail: 'inert fixture' };
    return { ok: true, launch: { seatId: row.id, provider: p.provider, command: p.command as [string, string], nativeStatePath: p.nativeStatePath, executable: p.executable } };
  });
  return f;
}
function input(f: ReturnType<typeof fixture>) {
  return { ...f.request, expectedPlanDigest: checkResourcePoolCommissioning(f.request).planDigest };
}
function multiProjectConsole(f: ReturnType<typeof fixture>) {
  const other = join(f.base, 'other-project'); mkdirSync(other, { mode: 0o700 });
  const projects = [pinResourceConsoleProject({ id: 'default', label: 'Default fixture', workspace: f.workspace }),
    pinResourceConsoleProject({ id: 'other', label: 'Other fixture', workspace: other })];
  const at = new Date().toISOString();
  const historical = { id: 'historical-other', projectId: 'other', state: 'settled', enqueuedAt: at, updatedAt: at,
    allowedWorkerIds: ['general'], mode: 'read-only', workerId: 'general', outcome: 'completed', reason: null,
    taskDigest: 'e'.repeat(64), input: null, retainHistory: true, history: { prompt: 'INERT_RETAINED_PROMPT', output: { text: 'INERT_RETAINED_OUTPUT', truncated: false } } };
  const task = { id: 'waiting-other', projectId: 'other', prompt: 'INERT_QUEUED_PROMPT', allowedWorkerIds: ['general'], mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 128 };
  const { projectId: _project, ...runtime } = task;
  const queued = { id: task.id, projectId: task.projectId, state: 'queued', enqueuedAt: at, updatedAt: at,
    allowedWorkerIds: task.allowedWorkerIds, mode: task.mode, workerId: null, outcome: null, reason: null, input: task,
    taskDigest: digest(canonical({ ...runtime, schemaVersion: 1, cwd: other })) };
  const state = { schemaVersion: 4, scopeDigest: digest(canonical({ pool: f.active.pool, bindings: f.active.bindings, workspace: f.workspace })),
    paused: true, projects, jobs: [historical, queued] };
  const file = join(f.root, 'resource-console-state.json'); save(file, state);
  return { file, state };
}
describe.skipIf(process.platform !== 'darwin')('commissioning recovery and historical preservation', () => {
  it('resumes after a durable console write without losing queued, retained or multi-project history', () => {
    const f = setup(); const console = multiProjectConsole(f); const request = input(f);
    const original = writes.writePrivateFileAtomically; let interrupted = false;
    const fault = vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((tmp, target, bytes, options) => {
      original(tmp, target, bytes, options);
      if (!interrupted && target === console.file) { interrupted = true; throw new Error('inert console publication interruption'); }
    });
    expect(() => applyResourcePoolCommissioning(request)).toThrow(); expect(interrupted).toBe(true);
    expect(f.ledger().pendingEvolution).toBeDefined(); fault.mockRestore();
    const result = resumeResourcePoolCommissioning(request); expect(result.disposition).toBe('resumed');
    expect(JSON.parse(readFileSync(console.file, 'utf8'))).toEqual({ ...console.state, schemaVersion: 5, originPoolDigest: f.active.poolDigest });
    expect(f.ledger().attempts).toEqual(f.state.attempts); expect(existsSync(f.invoked)).toBe(false);
  });
  it('preserves project directory pins and origin-scoped histories through finished replay', () => {
    const f = setup(); const console = multiProjectConsole(f); const request = input(f); applyResourcePoolCommissioning(request);
    const migrated = JSON.parse(readFileSync(console.file, 'utf8'));
    expect(migrated.projects).toEqual(console.state.projects); expect(migrated.jobs).toEqual(console.state.jobs);
    const before = tree(f.base); expect(resumeResourcePoolCommissioning(request)).toMatchObject({ disposition: 'replayed', stateChanged: false });
    expect(tree(f.base)).toEqual(before); expect(existsSync(f.invoked)).toBe(false);
  });
  it('replays old enrollment without overwriting a later additive epoch, receipts or reserved exposure', () => {
    const f = setup(); const request = input(f); applyResourcePoolCommissioning(request);
    const pool = f.currentPool(); const bindings = f.currentBindings();
    const nextPool = { ...pool, workers: [...pool.workers, { ...pool.workers[0], id: 'later-alias' }] };
    const nextBindings = [...bindings, { ...bindings.find((b: { workerId: string }) => b.workerId === 'general'), workerId: 'later-alias' }];
    const evolution = { root: f.root, workspace: f.workspace, pool, bindings, nextPool, nextBindings };
    applyResourcePoolEvolution({ ...evolution, expectedPlanDigest: checkResourcePoolEvolution(evolution).planDigest });
    const later = f.ledger(); save(join(f.accountsRoot, 'pool.json'), nextPool); save(join(f.accountsRoot, 'bindings.json'), nextBindings);
    const quota = f.currentQuota(); save(join(f.accountsRoot, 'quota-config.json'), { ...quota, poolDigest: later.poolDigest,
      workers: [...quota.workers, { ...quota.workers.find((w: { workerId: string }) => w.workerId === 'general'), workerId: 'later-alias' }] });
    // Simulate valid later ledger outcomes without contacting any worker.
    const completed = { ...later.attempts[0], id: 'later-result', poolDigest: later.poolDigest };
    const held = { ...completed, id: 'later-held', status: 'reserved', finishedAt: null, outputDigest: null, reason: 'synthetic-review' };
    later.attempts.push(completed, held); later.allocation = { ...later.allocation, ceilingPercent: 60, revision: 8 };
    later.workerAccess = { ...later.workerAccess, pausedWorkerIds: ['claude', 'cmp'], revision: 5 };
    decodeResourcePoolState(later, nextPool, nextBindings); save(join(f.root, 'pool-state.json'), later);
    const before = tree(f.base); expect(resumeResourcePoolCommissioning(request)).toMatchObject({ disposition: 'replayed', stateChanged: false });
    expect(tree(f.base)).toEqual(before); expect(f.ledger()).toEqual(later); expect(existsSync(f.invoked)).toBe(false);
  });
  it('completes only an exact same-plan staging prefix before atomic publication', () => {
    const f = setup(); const request = input(f); const staging = join(f.root, `.pool-commissioning-stage-${commissioningHash(f.request)}`);
    mkdirSync(staging, { mode: 0o700 }); save(join(staging, 'before-pool.json'), f.state);
    expect(() => resumeResourcePoolCommissioning(request)).toThrow();
    expect(applyResourcePoolCommissioning(request)).toMatchObject({ disposition: 'resumed', stateChanged: true });
    expect(existsSync(staging)).toBe(false); expect(f.ledger().attempts).toEqual(f.state.attempts); expect(existsSync(f.invoked)).toBe(false);
  });
  it('preserves unknown staging entries and refuses authoritative publication', () => {
    const f = setup(); const request = input(f); const staging = join(f.root, `.pool-commissioning-stage-${commissioningHash(f.request)}`);
    mkdirSync(staging, { mode: 0o700 }); save(join(staging, 'unknown.json'), { evidence: 'preserve' }); const before = tree(staging);
    expect(() => applyResourcePoolCommissioning(request)).toThrow(); expect(tree(staging)).toEqual(before);
    expect(f.ledger()).toEqual(f.state); expect(existsSync(join(f.root, 'pool-commissioning', commissioningHash(f.request)))).toBe(false);
    expect(existsSync(f.invoked)).toBe(false);
  });
  it.each([false, true])('refuses unknown authoritative parent entries without clearing them (finished=%s)', finished => {
    const f = setup(); const request = input(f); if (finished) applyResourcePoolCommissioning(request);
    const parent = join(f.root, 'pool-commissioning'); if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    const unknown = join(parent, 'unreviewed-custody'); mkdirSync(unknown, { mode: 0o700 }); save(join(unknown, 'evidence.json'), { preserve: true });
    const before = tree(f.base); expect(() => applyResourcePoolCommissioning(request)).toThrow(); expect(tree(f.base)).toEqual(before);
    expect(readdirSync(unknown)).toEqual(['evidence.json']);
    if (finished) expect(() => resourcePoolStatus(f.root, f.currentPool(), f.currentBindings(), [])).toThrow(/custody/);
    expect(existsSync(f.invoked)).toBe(false);
  });
});
