/** Real inert profiles and historical stores; this suite never executes a native binary. */
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { prepareResourceNativeProfile } from '../src/core/resources/native-profile.js';
import { resourcePoolConfigSnapshot, validateResourcePoolConfigHistory } from '../src/core/resources/pool-evolution-policy.js';
import { checkResourcePoolCommissioning, RESOURCE_POOL_COMMISSIONING_APPLICATION_HOLDS } from '../src/core/resources/pool-commissioning-check.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';
import * as reads from '../src/core/util/stable-file-read.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function tree(root: string): unknown {
  const stat = lstatSync(root, { bigint: true });
  return { identity: [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].map(String),
    contents: stat.isDirectory() ? readdirSync(root).sort().map(n => [n, tree(join(root, n))]) : readFileSync(root, 'utf8') };
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'commissioning-check-'))); roots.push(base);
  const accountsRoot = join(base, 'accounts'); const root = join(accountsRoot, 'ledger'); const workspace = join(base, 'workspace');
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(accountsRoot, 0o700); mkdirSync(workspace, { mode: 0o700 });
  const binary = join(base, 'INERT-NEVER-LAUNCH'); const nativeCalls = join(base, 'NATIVE-CALLS');
  writeFileSync(binary, `#!${realpathSync(process.execPath)}\nrequire('node:fs').writeFileSync(${JSON.stringify(nativeCalls)},'CALLED');\n`, { mode: 0o700 });
  const personal = prepareResourceNativeProfile({ provider: 'codex', directory: join(base, 'personal'), executable: binary });
  const cmp = prepareResourceNativeProfile({ provider: 'codex', directory: join(base, 'cmp'), executable: binary });
  const claude = prepareResourceNativeProfile({ provider: 'claude', directory: join(base, 'claude'), executable: binary });
  const general = { id: 'general', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1,
    reservePercent: 0, maxTasksPerWindow: 6, taskWindowMs: 60_000, priority: 1 };
  const oldPool = { schemaVersion: 1, id: 'subscriptions', workers: [general, { ...general, id: 'cmp' }, { ...general, id: 'claude', provider: 'claude', model: 'opus' }] };
  const oldBindings = oldPool.workers.map(w => ({ workerId: w.id, capacityKey: w.id === 'general' ? 'personal' : w.id,
    kind: 'native-cli', command: [realpathSync(process.execPath), join(base, `legacy-${w.id}.mjs`)] }));
  const old = resourcePoolConfigSnapshot(oldPool, oldBindings);
  const active = resourcePoolConfigSnapshot({ ...oldPool, workers: [{ ...general, quotaScope: 'codex-general-v1' },
    oldPool.workers[1], oldPool.workers[2], { ...general, id: 'spark', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' }] },
  [...oldBindings, { ...oldBindings[0], workerId: 'spark' }]);
  const at = new Date(Date.now() - 1000).toISOString();
  const attempts = Array.from({ length: 5 }, (_, i) => ({ schemaVersion: 1, id: `task-${i}`, taskDigest: '1'.repeat(64),
    poolDigest: i < 3 ? old.poolDigest : active.poolDigest, workerId: 'general', capacityKey: 'personal',
    status: i === 4 ? 'cancelled' : 'completed', startedAt: at, finishedAt: at, outputDigest: i === 4 ? null : '2'.repeat(64),
    inputTokens: null, outputTokens: null, reason: 'fixture', verifiedAccepted: false }));
  const state = { schemaVersion: 2, poolDigest: active.poolDigest, configurationHistory: [old, active], observations: [], attempts,
    allocation: { ceilingPercent: 75, revision: 3, updatedAt: at }, workerAccess: { pausedWorkerIds: ['claude'], revision: 2, updatedAt: at },
    quotaScopeAccess: { exclusions: [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }], revision: 1, updatedAt: at } };
  save(join(root, 'pool-state.json'), state); save(join(accountsRoot, 'pool.json'), old.pool); save(join(accountsRoot, 'bindings.json'), old.bindings);
  save(join(accountsRoot, 'quota-config.json'), { schemaVersion: 1, poolDigest: old.poolDigest,
    workers: [{ workerId: 'general', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }, { workerId: 'cmp', accountHint: 'b'.repeat(64), bucketIds: ['codex'] }] });
  const roster = { schemaVersion: 1, intervalMs: 30_000, accounts: [
    { id: 'new-personal', label: 'PRIVATE_PERSONAL_LABEL', provider: 'codex', command: personal.command, expectedAccountHint: 'c'.repeat(64) },
    { id: 'new-cmp', label: 'PRIVATE_CMP_LABEL', provider: 'codex', command: cmp.command, expectedAccountHint: 'd'.repeat(64) },
    { id: 'new-claude', label: 'PRIVATE_CLAUDE_LABEL', provider: 'claude', command: claude.command }] };
  save(join(accountsRoot, 'connections.json'), roster);
  const request = { root, workspace, accountsRoot, acknowledgment: 'new-roster-enrollment-without-continuity',
    enrollments: [{ capacityKey: 'personal', seatId: 'new-personal' }, { capacityKey: 'cmp', seatId: 'new-cmp' }, { capacityKey: 'claude', seatId: 'new-claude' }] };
  return { base, accountsRoot, root, workspace, state, old, active, request, roster, personal, cmp, claude, nativeCalls };
}
function held(f: ReturnType<typeof fixture>, code: string) {
  const before = tree(f.base); expect(() => checkResourcePoolCommissioning(f.request)).toThrow(`held: ${code}`);
  expect(tree(f.base)).toEqual(before); expect(existsSync(f.nativeCalls)).toBe(false);
}

describe.skipIf(process.platform !== 'darwin')('read-only pool commissioning preparation', () => {
  it('prepares exact historical-to-active four-worker recovery without changing receipts, policies or files', () => {
    const f = fixture(); const before = tree(f.base); const p = checkResourcePoolCommissioning(f.request);
    expect(p).toMatchObject({ status: 'planned', configurationDisposition: 'historical', historyCount: 2, preservedReceiptCount: 5,
      applicationReady: false, applicationImplemented: true, executionAuthorized: false, providerContacted: false,
      identityContinuityVerified: false, independentAccountIdentityVerified: false, stateChanged: false });
    expect(p.invalidatedWorkerIds).toEqual(['general', 'spark', 'cmp', 'claude']);
    expect(p.proposedCapacities[0]?.workerIds).toEqual(['general', 'spark']);
    expect(p.applicationHolds).toEqual(RESOURCE_POOL_COMMISSIONING_APPLICATION_HOLDS);
    expect(p.targetPoolDigest).not.toBe(f.active.poolDigest);
    expect(checkResourcePoolCommissioning(f.request)).toEqual(p); expect(tree(f.base)).toEqual(before);
    expect(existsSync(f.nativeCalls)).toBe(false);
    expect(JSON.stringify(p)).not.toMatch(/PRIVATE_.*_LABEL|cccccccccccc|dddddddddddd/);
    // A prepared plan cannot broaden the actual historical decoder or admit rebinding.
    const rebound = resourcePoolConfigSnapshot(f.active.pool, f.active.bindings.map(b => b.workerId === 'general' || b.workerId === 'spark' ? { ...b, command: f.personal.command } : b));
    expect(() => validateResourcePoolConfigHistory([f.old, f.active, rebound])).toThrow(/cannot change existing account bindings/);
  });
  it('retains old-epoch queued and historical transcript identity without offering context transfer', () => {
    const f = fixture(); const at = new Date().toISOString();
    const input = { id: 'waiting', prompt: 'PRIVATE_QUEUED_SENTINEL', allowedWorkerIds: ['general'], mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 128 };
    const queued = { id: input.id, state: 'queued', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['general'], mode: 'read-only',
      workerId: null, outcome: null, reason: null, input, taskDigest: digest(canonical({ ...input, schemaVersion: 1, cwd: f.workspace })) };
    const historical = { id: 'historical', state: 'settled', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['general'], mode: 'read-only',
      workerId: 'general', outcome: 'completed', reason: null, input: null, taskDigest: 'e'.repeat(64), retainHistory: true,
      history: { prompt: 'PRIVATE_OLD_PROMPT', output: { text: 'PRIVATE_OLD_RESULT', truncated: false } } };
    const scopeDigest = digest(canonical({ pool: f.old.pool, bindings: f.old.bindings, workspace: f.workspace }));
    save(join(f.root, 'resource-console-state.json'), { schemaVersion: 5, scopeDigest, originPoolDigest: f.old.poolDigest,
      paused: true, jobs: [historical, queued] });
    const before = tree(f.base); const p = checkResourcePoolCommissioning(f.request);
    expect(p.preservedJobCount).toBe(2); expect(p.heldQueuedIds).toEqual(['waiting']);
    expect(p.applicationHolds).toContain('current-account-quota-and-billing-qualification-required');
    expect(JSON.stringify(p)).not.toContain('PRIVATE_'); expect(tree(f.base)).toEqual(before);
  });
  it.each(['pool.json', 'bindings.json', 'quota-config.json', 'connections.json'])('refuses a partial %s publication without repairing it', name => {
    const f = fixture(); writeFileSync(join(f.accountsRoot, name), '{'); held(f, 'state-unavailable');
  });
  it('changes the plan digest when reviewed roster pins change, without changing actual custody', () => {
    const f = fixture(); const first = checkResourcePoolCommissioning(f.request);
    f.roster.accounts[0]!.expectedAccountHint = '9'.repeat(64); save(join(f.accountsRoot, 'connections.json'), f.roster);
    const before = tree(f.base); const next = checkResourcePoolCommissioning(f.request);
    expect(next.planDigest).not.toBe(first.planDigest); expect(next.targetConfigurationDigest).not.toBe(first.targetConfigurationDigest);
    expect(next.fromPoolDigest).toBe(first.fromPoolDigest); expect(tree(f.base)).toEqual(before);
  });
  it.each(['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'])('refuses any %s without treating ownership as stale', name => {
    const f = fixture(); save(join(f.root, name), { unknown: 'ownership' }); held(f, 'ownership-present');
  });
  it('refuses opaque quota marker even with a historical recovery receipt', () => {
    const f = fixture(); save(join(f.root, '.resource-quota-refresh-pending.json'), { ownerPid: 999999 });
    save(join(f.root, '.resource-quota-refresh-recovery.json'), { state: 'authorized-before-unlink' }); held(f, 'uncertain-work');
  });
  it.each(['missing', 'partial', 'unknown-schema', 'unknown-barrier', 'reserved', 'uncertain', 'missing-origin'])('preserves %s ledger refusal evidence', variant => {
    const f = fixture(); const path = join(f.root, 'pool-state.json');
    if (variant === 'missing') rmSync(path);
    else if (variant === 'partial') writeFileSync(path, '{"schemaVersion":2');
    else {
      const state = structuredClone(f.state) as Record<string, unknown>;
      if (variant === 'unknown-schema') state.schemaVersion = 99;
      if (variant === 'unknown-barrier') state.pendingEvolution = { planDigest: '1'.repeat(64) };
      if (variant === 'missing-origin') (state.attempts as typeof f.state.attempts)[0]!.poolDigest = 'f'.repeat(64);
      if (variant === 'reserved' || variant === 'uncertain') {
        const row = (state.attempts as typeof f.state.attempts)[0]!; row.status = variant;
        if (variant === 'reserved') { Object.assign(row, { finishedAt: null, outputDigest: null }); }
      }
      save(path, state);
    }
    held(f, variant === 'reserved' || variant === 'uncertain' ? 'uncertain-work' : 'state-unavailable');
  });
  it('rejects mixed historical/active operator files', () => {
    const f = fixture(); save(join(f.accountsRoot, 'bindings.json'), f.active.bindings); held(f, 'state-unavailable');
  });
  it('rejects an external policy mutation instead of incorporating it into the target', () => {
    const f = fixture(); save(join(f.accountsRoot, 'pool.json'), { ...f.old.pool, workers: f.old.pool.workers.map(w => ({ ...w, maxTasksPerWindow: 99 })) }); held(f, 'config-conflict');
  });
  it.each(['partial-alias-request', 'duplicate-seat', 'wrong-provider', 'missing-seat', 'duplicate-hint', 'missing-hint'])('refuses %s enrollment ambiguity', variant => {
    const f = fixture();
    if (variant === 'partial-alias-request') f.request.enrollments[0]!.capacityKey = 'spark';
    if (variant === 'duplicate-seat') f.request.enrollments[1]!.seatId = f.request.enrollments[0]!.seatId;
    if (variant === 'wrong-provider') { f.request.enrollments[0]!.seatId = 'new-claude'; f.request.enrollments[2]!.seatId = 'new-personal'; }
    if (variant === 'missing-seat') f.request.enrollments[0]!.seatId = 'absent';
    if (variant === 'duplicate-hint') { f.roster.accounts[1]!.expectedAccountHint = f.roster.accounts[0]!.expectedAccountHint; save(join(f.accountsRoot, 'connections.json'), f.roster); }
    if (variant === 'missing-hint') { delete f.roster.accounts[0]!.expectedAccountHint; save(join(f.accountsRoot, 'connections.json'), f.roster); }
    held(f, variant === 'duplicate-seat' ? 'invalid-input' : 'enrollment-invalid');
  });
  it.each(['symlink', 'hardlink', 'world-readable'])('refuses %s selected config files', variant => {
    const f = fixture(); const path = join(f.accountsRoot, 'quota-config.json');
    if (variant === 'symlink') { const bytes = readFileSync(path); rmSync(path); writeFileSync(join(f.base, 'quota'), bytes, { mode: 0o600 }); symlinkSync(join(f.base, 'quota'), path); }
    if (variant === 'hardlink') linkSync(path, join(f.base, 'quota-hardlink'));
    if (variant === 'world-readable') chmodSync(path, 0o644);
    const before = readFileSync(path); expect(() => checkResourcePoolCommissioning(f.request)).toThrow(/state-unavailable/); expect(readFileSync(path)).toEqual(before);
  });
  it('refuses a changed profile witness and never upgrades or executes it', () => {
    const f = fixture(); const p = JSON.parse(readFileSync(f.personal.manifestPath, 'utf8'));
    p.identity.directories[0].ino = '1'; save(f.personal.manifestPath, p); held(f, 'profile-invalid');
  });
  it('refuses unknown completed or partial commissioning custody rather than accepting ready.json alone', () => {
    const f = fixture(); const custody = join(f.root, 'pool-commissioning'); mkdirSync(custody, { mode: 0o700 });
    save(join(custody, 'ready.json'), { claimed: 'completed' }); held(f, 'state-unavailable');
  });
  it('rejects a quota marker appearing during metadata inspection without deleting it', () => {
    const f = fixture(); const original = reads.readStableRegularFile; let installed = false;
    vi.spyOn(reads, 'readStableRegularFile').mockImplementation((path, options) => {
      const r = original(path, options);
      if (!installed && path === f.personal.manifestPath) { installed = true; save(join(f.root, '.resource-quota-refresh-pending.json'), { unknown: true }); }
      return r;
    });
    expect(() => checkResourcePoolCommissioning(f.request)).toThrow(/uncertain-work/);
    expect(existsSync(join(f.root, '.resource-quota-refresh-pending.json'))).toBe(true); expect(existsSync(f.nativeCalls)).toBe(false);
  });
  it('refuses a workspace path symlink instead of binding an ambiguous target', () => {
    const f = fixture(); const link = join(f.base, 'workspace-link'); symlinkSync(f.workspace, link); f.request.workspace = link;
    const before = readFileSync(join(f.root, 'pool-state.json')); expect(() => checkResourcePoolCommissioning(f.request)).toThrow(/state-unavailable/);
    expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(before);
  });
  it('refuses roster bytes changed during planning rather than issuing a plan with mixed pins', () => {
    const f = fixture(); const original = reads.readStableRegularFile; let changed = false;
    vi.spyOn(reads, 'readStableRegularFile').mockImplementation((path, options) => {
      const result = original(path, options);
      if (!changed && path === join(f.accountsRoot, 'connections.json')) {
        changed = true; f.roster.accounts[0]!.label = 'UPDATED_PRIVATE_LABEL'; save(path, f.roster);
      }
      return result;
    });
    expect(() => checkResourcePoolCommissioning(f.request)).toThrow(/state-changed/); expect(existsSync(f.nativeCalls)).toBe(false);
  });
  it('holds all application even when worker-only observations have future timestamps and ready health', () => {
    const f = fixture(); f.state.observations = f.active.pool.workers.map(w => ({ workerId: w.id, health: 'ready', retryAfter: null,
      observedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 50_000).toISOString(), windows: [] })) as never[];
    save(join(f.root, 'pool-state.json'), f.state); const p = checkResourcePoolCommissioning(f.request);
    expect(p.applicationReady).toBe(false); expect(p.applicationHolds).toContain('fresh-target-collector-evidence-required');
  });
});

describe('commissioning check CLI authority boundary', () => {
  it.each(['apply', 'resume'])('rejects writable %s before inspecting any request', async action => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourcePool(['commission', action, '--request', '/private/never-read', '--json'])).toBe(2);
    expect(out.mock.calls.flat().join('')).toContain('--expected-plan-digest');
  });
  it('rejects provider witness fields and accessors before inspection', () => {
    let touched = false;
    expect(() => checkResourcePoolCommissioning({ get root() { touched = true; return '/private'; } })).toThrow(/invalid-input/);
    expect(touched).toBe(false);
    expect(() => checkResourcePoolCommissioning({ providerProof: { verified: true } })).toThrow(/invalid-input/);
  });
});
