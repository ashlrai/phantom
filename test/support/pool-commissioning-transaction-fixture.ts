/** Independent review fixtures: private temporary stores and an inert executable only. */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../../src/core/universe/artifacts.js';
import { prepareResourceNativeProfile, type ResourceNativeProfile, type ResourceNativeProfileProvider } from '../../src/core/resources/native-profile.js';
import { resourcePoolConfigSnapshot } from '../../src/core/resources/pool-evolution-policy.js';

export function saveIndependentJson(path: string, value: unknown): void {
  writeFileSync(path, `${canonical(value)}\n`, { mode: 0o600 });
}

/** Excludes atime because ordinary reads may update it; pins contents and mutation metadata. */
export function independentTree(path: string): unknown {
  if (!existsSync(path)) return { missing: true };
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) return { symlink: true, inode: String(stat.ino) };
  return {
    identity: [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].map(String),
    contents: stat.isDirectory()
      ? readdirSync(path).sort().map(name => [name, independentTree(join(path, name))])
      : digest(readFileSync(path)),
  };
}

export function independentCommissioningFixture(realWitness = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'commissioning-independent-')));
  const accountsRoot = join(base, 'accounts');
  const root = join(accountsRoot, 'ledger');
  const workspace = join(base, 'workspace');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(accountsRoot, 0o700);
  mkdirSync(workspace, { mode: 0o700 });
  const invoked = join(base, 'inert-invocations');
  const executable = join(base, 'inert-never-provider');
  writeFileSync(executable, `#!${realpathSync(process.execPath)}\nrequire('node:fs').appendFileSync(${JSON.stringify(invoked)}, 'CALLED\\n');\n`, { mode: 0o700 });
  // Protocol-only fixtures intentionally cannot pass the production native resolver.
  // Their owned test resolver is explicit; genuine APFS cases retain the real port.
  const profile = (provider: ResourceNativeProfileProvider, directory: string): ResourceNativeProfile => {
    if (realWitness) return prepareResourceNativeProfile({ provider, directory, executable });
    mkdirSync(directory, { mode: 0o700 }); const nativeStatePath = join(directory, 'native-state'); mkdirSync(nativeStatePath, { mode: 0o700 });
    const launcherPath = join(directory, 'launcher.mjs'); const commandPath = join(directory, 'command.json');
    const manifestPath = join(directory, 'profile.json'); const command = [realpathSync(process.execPath), launcherPath];
    const p: ResourceNativeProfile = { schemaVersion: 2, scope: 'native-profile-preparation', status: 'prepared', authentication: 'not-checked',
      provider, directory, executable, nodeExecutable: command[0]!, commandPath, launcherPath, nativeStatePath,
      anthropicStatePath: null, manifestPath, command, loginCommand: command, identity: { preparedBootId: 'PROTOCOL-ONLY', directories: [] } };
    saveIndependentJson(manifestPath, p); saveIndependentJson(commandPath, command); writeFileSync(launcherPath, '// INERT PROTOCOL FIXTURE\n', { mode: 0o600 });
    return p;
  };
  const personal = profile('codex', join(base, 'personal-profile'));
  const cmp = profile('codex', join(base, 'cmp-profile'));
  const claude = profile('claude', join(base, 'claude-profile'));
  const worker = { id: 'general', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1,
    reservePercent: 0, maxTasksPerWindow: 20, taskWindowMs: 60_000, priority: 1 };
  const old = resourcePoolConfigSnapshot({ schemaVersion: 1, id: 'independent-review', workers: [worker,
    { ...worker, id: 'cmp' }, { ...worker, id: 'claude', provider: 'claude', model: 'opus' }] }, [
    { workerId: 'general', capacityKey: 'personal', kind: 'native-cli', command: [process.execPath, join(base, 'old-personal.mjs')] },
    { workerId: 'cmp', capacityKey: 'cmp', kind: 'native-cli', command: [process.execPath, join(base, 'old-cmp.mjs')] },
    { workerId: 'claude', capacityKey: 'claude', kind: 'native-cli', command: [process.execPath, join(base, 'old-claude.mjs')] },
  ]);
  const active = resourcePoolConfigSnapshot({ ...old.pool, workers: [
    { ...old.pool.workers[0]!, quotaScope: 'codex-general-v1' }, old.pool.workers[1]!, old.pool.workers[2]!,
    { ...old.pool.workers[0]!, id: 'spark', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
  ] }, [...old.bindings, { ...old.bindings[0]!, workerId: 'spark' }]);
  const at = new Date(Date.now() - 5_000).toISOString();
  const attempts = Array.from({ length: 5 }, (_, index) => ({ schemaVersion: 1, id: `prior-${index}`,
    taskDigest: '1'.repeat(64), poolDigest: index < 3 ? old.poolDigest : active.poolDigest,
    workerId: 'general', capacityKey: 'personal', status: 'completed', startedAt: at, finishedAt: at,
    outputDigest: '2'.repeat(64), inputTokens: null, outputTokens: null, reason: 'synthetic-review', verifiedAccepted: false }));
  const state = { schemaVersion: 2, poolDigest: active.poolDigest, configurationHistory: [old, active],
    observations: [], attempts, allocation: { ceilingPercent: 75, revision: 7, updatedAt: at },
    workerAccess: { pausedWorkerIds: ['claude'], revision: 4, updatedAt: at },
    quotaScopeAccess: { exclusions: [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }], revision: 3, updatedAt: at } };
  saveIndependentJson(join(root, 'pool-state.json'), state);
  saveIndependentJson(join(accountsRoot, 'pool.json'), old.pool);
  saveIndependentJson(join(accountsRoot, 'bindings.json'), old.bindings);
  saveIndependentJson(join(accountsRoot, 'quota-config.json'), { schemaVersion: 1, poolDigest: old.poolDigest,
    workers: [{ workerId: 'general', accountHint: 'a'.repeat(64), bucketIds: ['codex'] },
      { workerId: 'cmp', accountHint: 'b'.repeat(64), bucketIds: ['codex'] }] });
  const roster = { schemaVersion: 1, intervalMs: 30_000, accounts: [
    { id: 'new-personal', label: 'PRIVATE-PERSONAL', provider: 'codex', command: personal.command, expectedAccountHint: 'c'.repeat(64) },
    { id: 'new-cmp', label: 'PRIVATE-CMP', provider: 'codex', command: cmp.command, expectedAccountHint: 'd'.repeat(64) },
    { id: 'new-claude', label: 'PRIVATE-CLAUDE', provider: 'claude', command: claude.command },
  ] };
  saveIndependentJson(join(accountsRoot, 'connections.json'), roster);
  const request = { root, workspace, accountsRoot, acknowledgment: 'new-roster-enrollment-without-continuity',
    enrollments: [{ capacityKey: 'personal', seatId: 'new-personal' }, { capacityKey: 'cmp', seatId: 'new-cmp' },
      { capacityKey: 'claude', seatId: 'new-claude' }] };
  return { base, accountsRoot, root, workspace, invoked, personal, cmp, claude, old, active, state, request, roster,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    ledger: () => JSON.parse(readFileSync(join(root, 'pool-state.json'), 'utf8')),
    currentPool: () => JSON.parse(readFileSync(join(accountsRoot, 'pool.json'), 'utf8')),
    currentBindings: () => JSON.parse(readFileSync(join(accountsRoot, 'bindings.json'), 'utf8')),
    currentQuota: () => JSON.parse(readFileSync(join(accountsRoot, 'quota-config.json'), 'utf8')),
  };
}
