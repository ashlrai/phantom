/** Immutable local enrollment custody. No provider calls or credential contents. */
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { decodeResourcePoolState, requireResourcePoolSettlementHeadroom, type ResourcePoolState } from './pool-runtime.js';
import type { ResourcePoolConfigSnapshot } from './pool-evolution-types.js';
import { resourcePoolConfigSnapshot, validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import { validateResourceQuotaRefreshConfig } from './quota-refresh-config.js';
import { resourceQuotaBuckets } from './quota-scope.js';
import { validateResourcePoolCommissioningJournal } from './pool-commissioning.js';
import { resolveNativeSeatLaunch } from './native-profile.js';
import { decodeResourceConsoleState } from './pool-supervisor.js';
import { assertConsolePreserved, type ConsoleProof } from './pool-evolution.js';
export const COMMISSIONING_BYTES = 4 * 1024 * 1024;
export const commissioningHash = (value: unknown): string => digest(canonical(value));
export function commissioningPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export function readCommissioningText(path: string, anchor: string): string {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || (s.mode & 511n) !== 384n ||
    typeof process.getuid === 'function' && s.uid !== BigInt(process.getuid())) throw new Error('Commissioning custody unavailable');
  const r = readStableRegularFile(path, { anchorPath: anchor, maxFileBytes: COMMISSIONING_BYTES, remainingBytes: COMMISSIONING_BYTES });
  if (!r.ok) throw new Error('Commissioning custody unavailable'); return r.text;
}
export function readCommissioningData(path: string, anchor: string): unknown { return JSON.parse(readCommissioningText(path, anchor)) as unknown; }
export function commissioningProfileMetadata(accountsRoot: string, provider: 'codex' | 'claude', seatId: string, command: string[], fullWitness = true): string {
  if (fullWitness) {
  const result = resolveNativeSeatLaunch({ accountsRoot, provider, seatId });
  if (!result.ok || canonical(result.launch.command) !== canonical(command)) throw new Error('Commissioning profile unavailable');
  }
  const directory = dirname(command[1]!);
  const profile = readCommissioningData(join(directory, 'profile.json'), directory) as { schemaVersion?: number };
  if (profile.schemaVersion !== 2) throw new Error('Commissioning profile requires a reboot witness');
  return commissioningHash({ profile, command, launcher: readCommissioningText(join(directory, 'launcher.mjs'), directory),
    commandFile: readCommissioningData(join(directory, 'command.json'), directory) });
}
/** Auth-file metadata only. Missing/unsafe metadata cannot qualify a collected sample. */
export function commissioningProfileEpoch(command: string[], provider: 'codex' | 'claude'): string {
  const directory = join(dirname(command[1]!), 'native-state'); inspectPrivateDirectory(directory);
  const file = join(directory, provider === 'claude' ? '.claude.json' : 'auth.json'); const s = lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || (s.mode & 511n) !== 384n || s.size < 2n || s.size > 2n * 1024n * 1024n ||
    typeof process.getuid === 'function' && s.uid !== BigInt(process.getuid())) throw new Error('Commissioning profile epoch unavailable');
  return commissioningHash([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].map(String));
}
export function deriveResourcePoolCommissionedState(before: ResourcePoolState, to: ResourcePoolConfigSnapshot): ResourcePoolState {
  const oldHistory = validateResourcePoolConfigHistory(before.configurationHistory); const from = oldHistory.at(-1)!;
  const old = decodeResourcePoolState(before, from.pool, from.bindings);
  if (old.attempts.some(r => r.status === 'reserved' || r.status === 'uncertain')) throw new Error('Commissioning requires settled work');
  const history = validateResourcePoolConfigHistory([...oldHistory, to]);
  const ids = new Set(to.commissioning!.workers.map(row => row.workerId));
  const observations = old.observations.map(row => {
    if (!ids.has(row.workerId)) return row;
    const { commissioning: _old, ...rest } = row;
    return { ...rest, health: 'unavailable' as const, windows: [] };
  });
  const after = decodeResourcePoolState({ ...old, poolDigest: to.poolDigest, configurationHistory: history, observations }, to.pool, to.bindings);
  requireResourcePoolSettlementHeadroom(after, to.pool); return after;
}
export interface ResourceCommissioningFence {
  planDigest: string; poolDigest: string; profileMetadataDigest: string; collectorBindingDigest: string;
  accountsRoot: string; capacityKey: string; quotaAccountHint: string | null; quotaBucketIds: string[]; seatId: string; provider: 'codex' | 'claude'; command: string[];
}
export function resourceCommissioningFences(history: ResourcePoolConfigSnapshot[]): Map<string, ResourceCommissioningFence> {
  const fences = new Map<string, ResourceCommissioningFence>();
  for (const epoch of history) if (epoch.commissioning) for (const w of epoch.commissioning.workers) {
    const command = epoch.bindings.find(b => b.workerId === w.workerId)!;
    if (command.kind !== 'native-cli') throw new Error('Invalid commissioning fence');
    const provider = epoch.pool.workers.find(row => row.id === w.workerId)!.provider as 'codex' | 'claude';
    fences.set(w.workerId, { planDigest: epoch.commissioning.planDigest, poolDigest: epoch.poolDigest,
      profileMetadataDigest: w.profileMetadataDigest, collectorBindingDigest: w.collectorBindingDigest,
      accountsRoot: '', capacityKey: w.capacityKey, quotaAccountHint: w.quotaAccountHint, quotaBucketIds: w.quotaBucketIds, seatId: w.seatId, provider, command: command.command });
  }
  const active = history.at(-1);
  if (active) for (const binding of active.bindings) {
    if (fences.has(binding.workerId)) continue;
    const inherited = [...fences.values()].find(f => f.capacityKey === binding.capacityKey);
    if (inherited) fences.set(binding.workerId, { ...inherited, quotaBucketIds: resourceQuotaBuckets(active.pool.workers.find(w => w.id === binding.workerId)!) ?? inherited.quotaBucketIds });
  }
  return fences;
}
/** Every completed transition stays linked to its exact immutable snapshots and ready proof.
 * Later receipts/holds/observations are never rewritten merely to replay old enrollment. */
/** Strong current linkage used by every runtime/collector/effect admission. No weak-mode parameter. */
export function assertResourcePoolCommissioningCustody(root: string, state: ResourcePoolState): Map<string, ResourceCommissioningFence> {
  return verifyCustody(root, state, undefined, false);
}
/** Historical custody only, for read-only planning and owned offline publication/replay.
 * Never qualifies observations, provider execution or current runtime admission. */
export function assertOfflineResourcePoolCommissioningHistory(root: string, state: ResourcePoolState, allowedPendingRequest?: string): Map<string, ResourceCommissioningFence> {
  return verifyCustody(root, state, allowedPendingRequest, true);
}
function verifyCustody(root: string, state: ResourcePoolState, allowedPendingRequest: string | undefined, offlineSnapshot: boolean): Map<string, ResourceCommissioningFence> {
  try {
    const history = state.configurationHistory ?? []; const fences = resourceCommissioningFences(history);
    const consolePins: Array<{ workspace: string; proof: ConsoleProof }> = [];
    const parent = join(root, 'pool-commissioning'); const requests = new Set(history.flatMap(row => row.commissioning ? [row.commissioning.requestDigest] : []));
    if (allowedPendingRequest) requests.add(allowedPendingRequest);
    if (commissioningPresent(parent)) {
      inspectPrivateDirectory(parent);
      if (readdirSync(parent).some(name => !requests.has(name))) throw new Error();
    } else if (requests.size && [...requests].some(r => r !== allowedPendingRequest)) throw new Error();
    for (let index = 0; index < history.length; index++) {
      const epoch = history[index]!; const t = epoch.commissioning; if (!t) continue;
      const directory = join(parent, t.requestDigest); inspectPrivateDirectory(directory);
      const journal = readCommissioningData(join(directory, 'journal.json'), directory) as Record<string, unknown>;
      const ready = readCommissioningData(join(directory, 'ready.json'), directory);
      const before = readCommissioningData(join(directory, 'before-pool.json'), directory) as ResourcePoolState;
      const after = readCommissioningData(join(directory, 'after-pool.json'), directory) as ResourcePoolState;
      if (readdirSync(directory).sort().join(',') !== 'after-pool.json,before-pool.json,journal.json,ready.json') throw new Error();
      validateResourcePoolCommissioningJournal(journal as unknown as Parameters<typeof validateResourcePoolCommissioningJournal>[0], before, after, (journal.input as Parameters<typeof validateResourcePoolCommissioningJournal>[3]));
      const keys = ['schemaVersion', 'scope', 'requestDigest', 'input', 'plan', 'planBasis', 'stateDigests', 'configs', 'consoleProof', 'beforeConsoleDigest', 'afterConsoleDigest'];
      const hashes = journal.stateDigests as { beforePool: string; afterPool: string };
      const plan = journal.plan as { planDigest: string; preservationDigest: string; targetConsoleDigest: string; targetConsoleProofDigest: string };
      const basis = journal.planBasis as { input: unknown; report: unknown };
      if (Object.keys(journal).sort().join(',') !== keys.sort().join(',') || journal.schemaVersion !== 1 || journal.scope !== 'explicit-native-pool-commissioning' ||
        journal.requestDigest !== t.requestDigest || commissioningHash(journal.input) !== t.requestDigest || plan.planDigest !== t.planDigest ||
        commissioningHash(basis) !== t.planDigest || canonical(basis.input) !== canonical(journal.input) ||
        canonical(plan) !== canonical({ ...(basis.report as object), planDigest: commissioningHash(basis) }) ||
        plan.preservationDigest !== commissioningHash({ stateDigest: commissioningHash(before), consoleDigest: journal.beforeConsoleDigest }) ||
        plan.targetConsoleDigest !== journal.afterConsoleDigest || plan.targetConsoleProofDigest !== commissioningHash(journal.consoleProof) ||
        hashes.beforePool !== commissioningHash(before) || hashes.afterPool !== commissioningHash(after) ||
        canonical(ready) !== canonical({ schemaVersion: 1, planDigest: t.planDigest, journalDigest: commissioningHash(journal) }) ||
        canonical(validateResourcePoolConfigHistory(before.configurationHistory)) !== canonical(history.slice(0, index)) ||
        canonical(validateResourcePoolConfigHistory(after.configurationHistory)) !== canonical(history.slice(0, index + 1)) ||
        canonical(deriveResourcePoolCommissionedState(before, epoch)) !== canonical(after) || after.pendingEvolution !== undefined) throw new Error();
      for (const old of after.attempts) if (canonical(state.attempts.find(r => r.id === old.id)) !== canonical(old)) throw new Error();
      const input = journal.input as { root: string; accountsRoot: string; workspace: string };
      if (input.root !== root || !input.accountsRoot) throw new Error();
      if (!offlineSnapshot) consolePins.push({ workspace: input.workspace, proof: journal.consoleProof as ConsoleProof });
      for (const w of t.workers) {
        const current = fences.get(w.workerId)!;
        if (current.planDigest === t.planDigest) for (const f of fences.values()) if (f.planDigest === t.planDigest && f.capacityKey === w.capacityKey) f.accountsRoot = input.accountsRoot;
      }
    }
    if (!offlineSnapshot && fences.size) {
      const accountsRoot = [...fences.values()][0]!.accountsRoot;
      const selected = resourcePoolConfigSnapshot(readCommissioningData(join(accountsRoot, 'pool.json'), accountsRoot),
        readCommissioningData(join(accountsRoot, 'bindings.json'), accountsRoot));
      if (selected.poolDigest !== state.poolDigest) throw new Error();
      const quota = validateResourceQuotaRefreshConfig(readCommissioningData(join(accountsRoot, 'quota-config.json'), accountsRoot), selected.pool, selected.bindings);
      for (const [workerId, f] of fences) if (f.provider === 'codex') {
        const pin = quota.workers.find(w => w.workerId === workerId);
        const buckets = resourceQuotaBuckets(selected.pool.workers.find(w => w.id === workerId)!) ?? f.quotaBucketIds;
        if (!pin || pin.accountHint !== f.quotaAccountHint || canonical(pin.bucketIds) !== canonical(buckets)) throw new Error();
      }
      // Preserved historical origins are an admission fact, not mutable console labels.
      // The existing proof allows explicit history erasure and new jobs, while refusing
      // relabeling an old source into the currently commissioned account scope.
      for (const pin of consolePins) if (pin.proof.scopeDigest !== null) {
        const file = join(root, 'resource-console-state.json'); const active = history.at(-1)!;
        const console = commissioningPresent(file) ? decodeResourceConsoleState(readCommissioningData(file, root), {
          workspace: pin.workspace, pool: active.pool, bindings: active.bindings, configHistory: history,
        }) : null;
        assertConsolePreserved(console, pin.proof);
      }
    }
    // Only current target profiles are live requirements; older immutable snapshots remain historical.
    const profileChecks = new Map<string, string>();
    for (const f of offlineSnapshot ? [] : fences.values()) {
      const key = canonical([f.accountsRoot, f.provider, f.seatId, f.command]);
      const checked = profileChecks.get(key) ?? commissioningProfileMetadata(f.accountsRoot, f.provider, f.seatId, f.command);
      profileChecks.set(key, checked);
      if (!f.accountsRoot || checked !== f.profileMetadataDigest) throw new Error();
    }
    return fences;
  } catch { throw new Error('Resource commissioning custody unavailable; preserve evidence and resume the reviewed transaction'); }
}
