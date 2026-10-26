/** Explicit offline locator enrollment. This transaction grants no dispatch or account authority. */
import { lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { decodeResourcePoolState, type ResourcePoolState } from './pool-runtime.js';
import { decodeResourceConsoleState, previewResourceConsolePoolEvolution } from './pool-supervisor.js';
import { assertConsolePreserved, consoleProof, type ConsoleProof } from './pool-evolution.js';
import { resourcePoolConfigSnapshot, validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import { validateResourceQuotaRefreshConfig } from './quota-refresh-config.js';
import { prepareResourcePoolCommissioning, ResourcePoolCommissioningCheckError,
  validateResourcePoolCommissioningRequest, type ResourcePoolCommissioningCheckPlan, type ResourcePoolCommissioningCheckRequest } from './pool-commissioning-check.js';
import { assertOfflineResourcePoolCommissioningHistory, assertResourcePoolCommissioningCustody, COMMISSIONING_BYTES, commissioningHash as hash, commissioningPresent as present,
  commissioningProfileMetadata, deriveResourcePoolCommissionedState, readCommissioningData, readCommissioningText } from './pool-commissioning-custody.js';
export { ResourcePoolCommissioningCheckError };
export interface ResourcePoolCommissioningReport extends Omit<ResourcePoolCommissioningCheckPlan, 'status' | 'stateChanged'> {
  status: 'applied'; stateChanged: boolean; disposition: 'created' | 'resumed' | 'replayed';
}
interface Journal {
  schemaVersion: 1; scope: 'explicit-native-pool-commissioning'; requestDigest: string;
  planBasis: ReturnType<typeof prepareResourcePoolCommissioning>['planBasis'];
  input: ResourcePoolCommissioningCheckRequest; plan: ResourcePoolCommissioningCheckPlan;
  stateDigests: { beforePool: string; afterPool: string };
  configs: Array<{ path: string; beforeText: string; afterText: string }>;
  consoleProof: ConsoleProof; beforeConsoleDigest: string; afterConsoleDigest: string;
}
function fail(code: 'invalid-input' | 'ownership-present' | 'uncertain-work' | 'state-unavailable' | 'state-changed'): never {
  throw new ResourcePoolCommissioningCheckError(code);
}
function safe<T>(operation: () => T): T {
  try { return operation(); } catch (e) { if (e instanceof ResourcePoolCommissioningCheckError) throw e; return fail('state-unavailable'); }
}
function scope(input: unknown) {
  const request = validateResourcePoolCommissioningRequest(input); const requestDigest = hash(request);
  return { request, requestDigest, parent: join(request.root, 'pool-commissioning'), directory: join(request.root, 'pool-commissioning', requestDigest),
    poolFile: join(request.root, 'pool-state.json'), consoleFile: join(request.root, 'resource-console-state.json') };
}
type Scope = ReturnType<typeof scope>;
interface Staged { journal: Journal; before: ResourcePoolState; after: ResourcePoolState;
  pins?: Array<{ path: string; anchor: string; text: string; identity: string }>;
  directoryPins?: Array<{ path: string; identity: string }>;
}
function offline(root: string): void {
  if (['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'].some(name => present(join(root, name)))) fail('ownership-present');
  if (present(join(root, '.resource-quota-refresh-pending.json'))) fail('uncertain-work');
}
function optionalConsole(s: Scope): unknown { return present(s.consoleFile) ? readCommissioningData(s.consoleFile, s.request.root) : null; }
function build(s: Scope): Staged {
  const p = prepareResourcePoolCommissioning(s.request);
  const workers = p.target.bindings.filter(b => p.plan.invalidatedWorkerIds.includes(b.workerId)).map(b => {
    const enrollment = p.plan.proposedCapacities.find(c => c.workerIds.includes(b.workerId))!;
    return { workerId: b.workerId, capacityKey: b.capacityKey, seatId: enrollment.seatId, profileMetadataDigest: enrollment.profileMetadataDigest,
      quotaAccountHint: p.nextQuota.workers.find(w => w.workerId === b.workerId)?.accountHint ?? null,
      quotaBucketIds: p.nextQuota.workers.find(w => w.workerId === b.workerId)?.bucketIds ?? [],
      collectorBindingDigest: hash({ root: s.request.root, poolDigest: p.target.poolDigest, quotaConfigDigest: hash(p.nextQuota),
        workerId: b.workerId, command: b.kind === 'native-cli' ? b.command : [], profileMetadataDigest: enrollment.profileMetadataDigest }) };
  });
  const to = { ...p.target, commissioning: { schemaVersion: 1 as const, kind: 'explicit-native-roster-enrollment' as const, subscriptionOnlyBoundaryRequired: true as const,
    requestDigest: s.requestDigest, planDigest: p.plan.planDigest, rosterDigest: p.plan.rosterDigest, workers } };
  const after = deriveResourcePoolCommissionedState(p.state, to);
  const nextConsole = previewResourceConsolePoolEvolution(p.consoleValue, { workspace: s.request.workspace,
    from: p.active, to, configHistory: after.configurationHistory! });
  const configs = ['pool.json', 'bindings.json', 'quota-config.json'].map((name, index) => ({ path: join(s.request.accountsRoot, name),
    beforeText: p.captured.get(join(s.request.accountsRoot, name))!.file.text,
    afterText: canonical([to.pool, to.bindings, p.nextQuota][index]) + '\n' }));
  return { before: p.state, after, pins: [...p.captured].map(([path, row]) => ({ path, anchor: row.anchor, ...row.file })),
    directoryPins: p.directoryPins, journal: { schemaVersion: 1, scope: 'explicit-native-pool-commissioning', requestDigest: s.requestDigest,
    input: p.input, plan: p.plan, planBasis: p.planBasis, stateDigests: { beforePool: hash(p.state), afterPool: hash(after) }, configs,
    consoleProof: consoleProof(nextConsole), beforeConsoleDigest: hash(p.consoleValue), afterConsoleDigest: hash(nextConsole) } };
}
function load(s: Scope): Staged | null {
  if (!present(s.directory)) return null;
  inspectPrivateDirectory(s.parent); inspectPrivateDirectory(s.directory);
  const allowed = new Set(['before-pool.json', 'after-pool.json', 'journal.json', 'ready.json', 'ready.json.commissioning.tmp']);
  if (readdirSync(s.directory).some(name => !allowed.has(name))) fail('state-unavailable');
  const journal = readCommissioningData(join(s.directory, 'journal.json'), s.directory) as Journal;
  const before = readCommissioningData(join(s.directory, 'before-pool.json'), s.directory) as ResourcePoolState;
  const after = readCommissioningData(join(s.directory, 'after-pool.json'), s.directory) as ResourcePoolState;
  const staged = validateResourcePoolCommissioningJournal(journal, before, after, s.request);
  assertOfflineResourcePoolCommissioningHistory(s.request.root, before, s.requestDigest);
  const temporary = join(s.directory, 'ready.json.commissioning.tmp');
  if (present(temporary) && readCommissioningText(temporary, s.directory) !== json(ready(staged))) fail('state-unavailable');
  return staged;
}
export function validateResourcePoolCommissioningJournal(journal: Journal, before: ResourcePoolState, after: ResourcePoolState, request: ResourcePoolCommissioningCheckRequest): Staged {
  const requestDigest = hash(validateResourcePoolCommissioningRequest(request));
  const keys = ['schemaVersion', 'scope', 'requestDigest', 'input', 'plan', 'planBasis', 'stateDigests', 'configs', 'consoleProof', 'beforeConsoleDigest', 'afterConsoleDigest'];
  if (!journal || Object.keys(journal).sort().join(',') !== keys.sort().join(',') || journal.schemaVersion !== 1 || journal.scope !== 'explicit-native-pool-commissioning' ||
    journal.requestDigest !== requestDigest || canonical(journal.input) !== canonical(request) ||
    hash(journal.planBasis) !== journal.plan.planDigest || canonical(journal.planBasis.input) !== canonical(journal.input) ||
    canonical(journal.plan) !== canonical({ ...journal.planBasis.report, planDigest: hash(journal.planBasis) }) ||
    journal.plan.preservationDigest !== hash({ stateDigest: hash(before), consoleDigest: journal.beforeConsoleDigest }) ||
    journal.plan.targetConsoleDigest !== journal.afterConsoleDigest || journal.plan.targetConsoleProofDigest !== hash(journal.consoleProof) || journal.stateDigests.beforePool !== hash(before) ||
    journal.stateDigests.afterPool !== hash(after) || !/^[a-f0-9]{64}$/.test(journal.plan.planDigest) || journal.plan.applicationImplemented !== true ||
    journal.plan.applicationReady !== false || journal.plan.executionAuthorized !== false || journal.plan.identityContinuityVerified !== false ||
    journal.plan.independentAccountIdentityVerified !== false || journal.plan.providerContacted !== false || journal.plan.stateChanged !== false) fail('state-unavailable');
  const history = validateResourcePoolConfigHistory(after.configurationHistory); const to = history.at(-1)!; const from = history.at(-2)!;
  if (!to.commissioning || to.commissioning.requestDigest !== requestDigest || to.commissioning.planDigest !== journal.plan.planDigest ||
    to.commissioning.rosterDigest !== journal.plan.rosterDigest || journal.plan.fromPoolDigest !== from.poolDigest || journal.plan.targetPoolDigest !== to.poolDigest ||
    canonical(deriveResourcePoolCommissionedState(before, to)) !== canonical(after)) fail('state-unavailable');
  if (!Array.isArray(journal.configs) || journal.configs.length !== 3 || journal.configs.some((c, i) =>
    Object.keys(c).sort().join(',') !== 'afterText,beforeText,path' || c.path !== join(request.accountsRoot, ['pool.json', 'bindings.json', 'quota-config.json'][i]!) ||
    typeof c.beforeText !== 'string' || typeof c.afterText !== 'string')) fail('state-unavailable');
  const old = resourcePoolConfigSnapshot(JSON.parse(journal.configs[0]!.beforeText), JSON.parse(journal.configs[1]!.beforeText));
  if (!before.configurationHistory!.some(row => row.poolDigest === old.poolDigest)) fail('state-unavailable');
  validateResourceQuotaRefreshConfig(JSON.parse(journal.configs[2]!.beforeText), old.pool, old.bindings);
  const quota = validateResourceQuotaRefreshConfig(JSON.parse(journal.configs[2]!.afterText), to.pool, to.bindings);
  if (journal.configs[0]!.afterText !== canonical(to.pool) + '\n' || journal.configs[1]!.afterText !== canonical(to.bindings) + '\n' ||
    journal.configs[2]!.afterText !== canonical(quota) + '\n' || journal.plan.targetConfigurationDigest !== hash({ target: resourcePoolConfigSnapshot(to.pool, to.bindings), quota })) fail('state-unavailable');
  for (const w of to.commissioning.workers) {
    const b = to.bindings.find(b => b.workerId === w.workerId)!;
    const enrollment = journal.plan.proposedCapacities.find(c => c.workerIds.includes(w.workerId));
    const quotaPin = quota.workers.find(q => q.workerId === w.workerId);
    if (w.quotaAccountHint !== (quotaPin?.accountHint ?? null) || canonical(w.quotaBucketIds) !== canonical(quotaPin?.bucketIds ?? [])) fail('state-unavailable');
    if (b.kind !== 'native-cli' || !enrollment || enrollment.capacityKey !== w.capacityKey || enrollment.seatId !== w.seatId || enrollment.profileMetadataDigest !== w.profileMetadataDigest ||
      w.collectorBindingDigest !== hash({ root: request.root, poolDigest: to.poolDigest, quotaConfigDigest: hash(quota), workerId: w.workerId,
        command: b.command, profileMetadataDigest: w.profileMetadataDigest })) fail('state-unavailable');
  }
  return { journal, before, after };
}
function stagingDocuments(staged: Staged): Map<string, string> {
  return new Map([['before-pool.json', json(staged.before)], ['after-pool.json', json(staged.after)], ['journal.json', json(staged.journal)]]);
}
function validateStaging(s: Scope, staged: Staged): void {
  const directory = join(s.request.root, `.pool-commissioning-stage-${s.requestDigest}`); if (!present(directory)) return;
  inspectPrivateDirectory(directory); const documents = stagingDocuments(staged);
  for (const name of readdirSync(directory)) {
    const key = name.endsWith('.commissioning.tmp') ? name.slice(0, -'.commissioning.tmp'.length) : name;
    const expected = documents.get(key);
    if (expected === undefined || readCommissioningText(join(directory, name), directory) !== expected) fail('state-unavailable');
  }
}
function barrier(staged: Staged): ResourcePoolState { return { ...staged.after, pendingEvolution: { planDigest: staged.journal.plan.planDigest } }; }
function ready(staged: Staged) { return { schemaVersion: 1, planDigest: staged.journal.plan.planDigest, journalDigest: hash(staged.journal) }; }
function profiles(s: Scope, staged: Staged, fullWitness = true): void {
  const to = staged.after.configurationHistory!.at(-1)!;
  if (hash(readCommissioningData(join(s.request.accountsRoot, 'connections.json'), s.request.accountsRoot)) !== staged.journal.plan.rosterDigest) fail('state-changed');
  for (const w of to.commissioning!.workers) {
    const b = to.bindings.find(b => b.workerId === w.workerId)!; const provider = to.pool.workers.find(x => x.id === w.workerId)!.provider as 'codex' | 'claude';
    if (b.kind !== 'native-cli' || commissioningProfileMetadata(s.request.accountsRoot, provider, w.seatId, b.command, fullWitness) !== w.profileMetadataDigest) fail('state-changed');
  }
}
function verifyReady(s: Scope, staged: Staged): void {
  if (canonical(readCommissioningData(join(s.directory, 'ready.json'), s.directory)) !== canonical(ready(staged))) fail('state-unavailable');
}
function allBeforeConfigs(s: Scope, staged: Staged): void {
  for (const c of staged.journal.configs) if (readCommissioningText(c.path, s.request.accountsRoot) !== c.beforeText) fail('state-changed');
}
function allConfigsAfter(s: Scope, staged: Staged): void {
  for (const c of staged.journal.configs) if (readCommissioningText(c.path, s.request.accountsRoot) !== c.afterText) fail('state-changed');
}
function finalized(s: Scope, staged: Staged): boolean {
  if (!present(join(s.directory, 'ready.json'))) return false;
  if (canonical(readCommissioningData(join(s.directory, 'ready.json'), s.directory)) !== canonical(ready(staged))) fail('state-unavailable');
  const current = readCommissioningData(s.poolFile, s.request.root) as ResourcePoolState;
  if (current.pendingEvolution !== undefined) return false;
  const history = validateResourcePoolConfigHistory(current.configurationHistory);
  if (history.length < staged.after.configurationHistory!.length || canonical(history.slice(0, staged.after.configurationHistory!.length)) !== canonical(staged.after.configurationHistory)) fail('state-changed');
  const active = history.at(-1)!; const state = decodeResourcePoolState(current, active.pool, active.bindings);
  const operator = resourcePoolConfigSnapshot(readCommissioningData(join(s.request.accountsRoot, 'pool.json'), s.request.accountsRoot),
    readCommissioningData(join(s.request.accountsRoot, 'bindings.json'), s.request.accountsRoot));
  if (operator.poolDigest !== active.poolDigest) fail('state-changed');
  validateResourceQuotaRefreshConfig(readCommissioningData(join(s.request.accountsRoot, 'quota-config.json'), s.request.accountsRoot), active.pool, active.bindings);
  assertResourcePoolCommissioningCustody(s.request.root, state);
  for (const old of staged.after.attempts) if (canonical(state.attempts.find(r => r.id === old.id)) !== canonical(old)) fail('state-changed');
  const value = optionalConsole(s); const console = value === null ? null : decodeResourceConsoleState(value,
    { workspace: s.request.workspace, pool: active.pool, bindings: active.bindings, configHistory: history });
  assertConsolePreserved(console, staged.journal.consoleProof); return true;
}
function phase(s: Scope, staged: Staged): { phase: 'before' | 'barrier' | 'done'; console: unknown } {
  if (finalized(s, staged)) return { phase: 'done', console: null };
  const pool = readCommissioningData(s.poolFile, s.request.root); const value = optionalConsole(s);
  const old = canonical(pool) === canonical(staged.before); const pending = canonical(pool) === canonical(barrier(staged));
  if (!old && !pending) fail('state-changed');
  if (old && hash(value) !== staged.journal.beforeConsoleDigest) fail('state-changed');
  let console: unknown = value;
  if (hash(value) === staged.journal.beforeConsoleDigest) {
    const history = staged.after.configurationHistory!;
    console = previewResourceConsolePoolEvolution(value, { workspace: s.request.workspace, from: history.at(-2)!, to: history.at(-1)!, configHistory: history });
  }
  if (hash(console) !== staged.journal.afterConsoleDigest || canonical(consoleProof(console as Parameters<typeof consoleProof>[0])) !== canonical(staged.journal.consoleProof)) fail('state-changed');
  for (const c of staged.journal.configs) {
    const text = readCommissioningText(c.path, s.request.accountsRoot);
    if (text !== c.beforeText && text !== c.afterText || old && text !== c.beforeText) fail('state-changed');
  }
  return { phase: old ? 'before' : 'barrier', console };
}
export function checkResourcePoolCommissioning(input: unknown): ResourcePoolCommissioningCheckPlan {
  return safe(() => {
    const s = scope(input); const staged = load(s);
    if (!staged) { const fresh = build(s); validateStaging(s, fresh); return fresh.journal.plan; }
    const state = phase(s, staged); if (state.phase !== 'done') { offline(s.request.root); profiles(s, staged); }
    return staged.journal.plan;
  });
}
function write(anchor: string, target: string, bytes: string, guard: () => void): void {
  guard(); if (Buffer.byteLength(bytes) > COMMISSIONING_BYTES) fail('state-unavailable');
  const temporary = `${target}.commissioning.tmp`;
  if (present(temporary)) {
    const before = lstatSync(temporary, { bigint: true });
    if (readCommissioningText(temporary, anchor) !== bytes) fail('state-unavailable');
    guard(); const after = lstatSync(temporary, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) fail('state-changed');
    unlinkSync(temporary); fsyncDirectory(anchor);
  }
  writePrivateFileAtomically(temporary, target, bytes, { anchorPath: anchor, label: 'Pool commissioning' }); guard();
}
const json = (value: unknown) => canonical(value) + '\n';
export function applyResourcePoolCommissioning(input: ResourcePoolCommissioningCheckRequest & { expectedPlanDigest: string }): ResourcePoolCommissioningReport { return apply(input, false); }
export function resumeResourcePoolCommissioning(input: ResourcePoolCommissioningCheckRequest & { expectedPlanDigest: string }): ResourcePoolCommissioningReport { return apply(input, true); }
function apply(input: ResourcePoolCommissioningCheckRequest & { expectedPlanDigest: string }, requireExisting: boolean): ResourcePoolCommissioningReport {
  return safe(() => {
    const encoded = canonicalEvidencePackJsonV3(input); if (encoded === null || Buffer.byteLength(encoded) > 64 * 1024) fail('invalid-input');
    const detached = JSON.parse(encoded) as typeof input; const { expectedPlanDigest, ...options } = detached;
    if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest)) fail('invalid-input');
    const s = scope(options); const existing = load(s);
    const prepared = existing ?? (requireExisting ? null : build(s));
    if (!prepared) fail('state-unavailable');
    const plan = prepared.journal.plan; if (plan.planDigest !== expectedPlanDigest) fail('state-changed'); if (requireExisting && !existing) fail('state-unavailable');
    if (existing && finalized(s, existing)) return { ...plan, status: 'applied', stateChanged: false, disposition: 'replayed' };
    if (existing) phase(s, existing);
    offline(s.request.root);
    const fresh = prepared;
    if (!existing) validateStaging(s, fresh);
    if (fresh.journal.plan.planDigest !== expectedPlanDigest) fail('state-changed');
    const locks: NonNullable<ReturnType<typeof acquireLocalStoreLock>>[] = [];
    try {
      for (const name of ['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock']) {
        const lock = acquireLocalStoreLock(join(s.request.root, name), 0, { anchorPath: s.request.root, exactPrivateStorage: true });
        if (!lock) fail('ownership-present'); locks.push(lock);
      }
      let requireJournal = existing !== null; let requireReady = existing !== null && present(join(s.directory, 'ready.json'));
      const guard = () => {
        inspectPrivateDirectory(s.request.root); inspectPrivateDirectory(s.request.accountsRoot);
        if (locks.some(lock => !ownsLocalStoreLock(lock))) fail('ownership-present');
        if (present(join(s.request.root, '.resource-quota-refresh-pending.json'))) fail('uncertain-work');
        assertOfflineResourcePoolCommissioningHistory(s.request.root, fresh.before, s.requestDigest);
        if (requireJournal && canonical(load(s)?.journal) !== canonical(fresh.journal)) fail('state-unavailable');
        if (requireReady) verifyReady(s, fresh);
      };
      guard(); let staged = load(s); let resumed = staged !== null;
      if (!staged && (requireExisting || existing !== null)) fail('state-unavailable');
      if (!staged) {
        // Recheck the exact read-only snapshot under ownership before any staging or barrier.
        staged = fresh;
        for (const pin of staged.pins ?? []) {
          const stat = lstatSync(pin.path, { bigint: true });
          const identity = canonical([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink].map(String));
          if (identity !== pin.identity || readCommissioningText(pin.path, pin.anchor) !== pin.text) fail('state-changed');
        }
        for (const pin of staged.directoryPins ?? []) {
          const stat = lstatSync(pin.path, { bigint: true });
          if (canonical([stat.dev, stat.ino, stat.uid, stat.mode, stat.birthtimeNs].map(String)) !== pin.identity) fail('state-changed');
        }
        phase(s, staged); guard();
        if (!present(s.parent)) { guard(); mkdirSync(s.parent, { mode: 0o700 }); fsyncDirectory(s.request.root); }
        inspectPrivateDirectory(s.parent);
        const staging = join(s.request.root, `.pool-commissioning-stage-${s.requestDigest}`);
        if (present(staging)) resumed = true;
        if (!present(staging)) { guard(); mkdirSync(staging, { mode: 0o700 }); fsyncDirectory(s.request.root); }
        inspectPrivateDirectory(staging);
        const documents = stagingDocuments(staged);
        if (readdirSync(staging).some(name => !documents.has(name) && ![...documents.keys()].some(key => `${key}.commissioning.tmp` === name))) fail('state-unavailable');
        for (const [name, bytes] of documents) {
          const target = join(staging, name);
          if (present(target)) {
            if (readCommissioningText(target, staging) !== bytes) fail('state-unavailable');
            if (present(`${target}.commissioning.tmp`)) write(staging, target, bytes, guard);
          }
          else write(staging, target, bytes, guard);
        }
        if (readdirSync(staging).length !== documents.size) fail('state-unavailable');
        for (const [name, bytes] of documents) if (readCommissioningText(join(staging, name), staging) !== bytes) fail('state-changed');
        guard(); profiles(s, staged, false); allBeforeConfigs(s, staged); fsyncDirectory(staging);
        if (present(s.directory)) fail('state-changed');
        renameSync(staging, s.directory); fsyncDirectory(s.parent); fsyncDirectory(s.request.root); requireJournal = true; guard();
      }
      if (staged.journal.plan.planDigest !== expectedPlanDigest) fail('state-changed');
      guard(); profiles(s, staged); let current = phase(s, staged);
      if (current.phase === 'before') { write(s.request.root, s.poolFile, json(barrier(staged)), guard); current = phase(s, staged); }
      if (current.phase !== 'barrier') fail('state-changed');
      if (current.console !== null && hash(optionalConsole(s)) !== staged.journal.afterConsoleDigest) write(s.request.root, s.consoleFile, json(current.console), guard);
      for (const c of staged.journal.configs) {
        phase(s, staged); profiles(s, staged, false);
        if (readCommissioningText(c.path, s.request.accountsRoot) !== c.afterText) write(s.request.accountsRoot, c.path, c.afterText, guard);
      }
      phase(s, staged); profiles(s, staged, false); guard(); allConfigsAfter(s, staged);
      if (!present(join(s.directory, 'ready.json'))) write(s.directory, join(s.directory, 'ready.json'), json(ready(staged)), guard);
      else if (canonical(readCommissioningData(join(s.directory, 'ready.json'), s.directory)) !== canonical(ready(staged))) fail('state-unavailable');
      verifyReady(s, staged); requireReady = true;
      guard(); phase(s, staged); profiles(s, staged); allConfigsAfter(s, staged); verifyReady(s, staged);
      write(s.request.root, s.poolFile, json(staged.after), guard);
      if (!finalized(s, staged)) fail('state-unavailable');
      return { ...plan, status: 'applied', stateChanged: true, disposition: resumed ? 'resumed' : 'created' };
    } finally {
      let released = true; for (const lock of locks.reverse()) if (!releaseLocalStoreLock(lock)) released = false;
      if (!released) fail('ownership-present');
    }
  });
}
