/** Reject-only input continuity for ONE fresh publication. These metadata pins
 * never qualify a native witness, observation, launch or later publication. */
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical } from '../universe/artifacts.js';
import { decodeResourcePoolState } from './pool-runtime.js';
import { readCommissioningData, type ResourceCommissioningFence } from './pool-commissioning-custody.js';
import type { SharedQuotaScope } from './quota-shared-evidence.js';
export interface QuotaEvidenceRejectPins { scope: 'quota-publication-reject-only'; entries: Array<[string, string[] | null]> }
export function captureQuotaEvidenceRejectPins(scope: SharedQuotaScope): QuotaEvidenceRejectPins {
  const entries = new Map<string, string[] | null>();
  const pin = (path: string, directory = false): boolean => {
    if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || entries.size >= 2048) throw new Error('Quota publication inputs unavailable');
    let s;
    try { s = lstatSync(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { entries.set(path, null); return false; } throw error; }
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new Error('Quota publication inputs unavailable');
    entries.set(path, [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.birthtimeNs,
      // A sibling metadata refresh may change directory mtime without replacing it.
      ...(directory ? [] : [s.size, s.mtimeNs, s.ctimeNs])].map(String));
    return true;
  };
  const members = (path: string): string[] => {
    if (!pin(path, true)) return [];
    const names = readdirSync(path).sort();
    if (names.length > 2048 || names.some(name => name.includes('/') || name.length > 256)) throw new Error('Quota publication inputs unavailable');
    entries.set(`${path}/`, names); return names;
  };
  pin(scope.root, true);
  const statePath = join(scope.root, 'pool-state.json');
  const commissioningRoot = join(scope.root, 'pool-commissioning');
  members(commissioningRoot);
  pin(join(scope.root, 'resource-console-state.json'));
  if (pin(statePath)) {
    const state = decodeResourcePoolState(readCommissioningData(statePath, scope.root), scope.pool, scope.bindings);
    const profiles = new Map<string, Pick<ResourceCommissioningFence, 'accountsRoot' | 'command' | 'provider'>>();
    for (const epoch of state.configurationHistory ?? []) {
      if (!epoch.commissioning) continue;
      const directory = join(commissioningRoot, epoch.commissioning.requestDigest);
      members(directory);
      for (const name of ['journal.json', 'ready.json', 'before-pool.json', 'after-pool.json']) pin(join(directory, name));
      const journal = readCommissioningData(join(directory, 'journal.json'), directory) as { input?: { accountsRoot?: unknown } };
      const accountsRoot = journal.input?.accountsRoot;
      if (typeof accountsRoot !== 'string') throw new Error('Quota publication inputs unavailable');
      pin(accountsRoot, true);
      for (const name of ['connections.json', 'pool.json', 'bindings.json', 'quota-config.json']) pin(join(accountsRoot, name));
      for (const commissioned of epoch.commissioning.workers) {
        const binding = epoch.bindings.find(row => row.workerId === commissioned.workerId);
        const worker = epoch.pool.workers.find(row => row.id === commissioned.workerId);
        if (!binding || binding.kind !== 'native-cli' || !worker || !['codex', 'claude'].includes(worker.provider)) throw new Error('Quota publication inputs unavailable');
        // Only the most recent target for a worker is live, just as custody does.
        profiles.set(commissioned.workerId, { accountsRoot, command: binding.command, provider: worker.provider as 'codex' | 'claude' });
      }
    }
    for (const profile of profiles.values()) {
      const directory = dirname(profile.command[1]!);
      pin(dirname(directory), true); pin(directory, true); pin(join(directory, 'native-state'), true);
      if (profile.provider === 'claude') pin(join(directory, 'anthropic-state'), true);
      for (const name of ['profile.json', 'launcher.mjs', 'command.json']) pin(join(directory, name));
      // Credential bytes are never read. Preserve only the same auth-file metadata
      // already checked by commissioningProfileEpoch during fresh preparation.
      pin(join(directory, 'native-state', profile.provider === 'claude' ? '.claude.json' : 'auth.json'));
      const manifest = readCommissioningData(join(directory, 'profile.json'), directory) as { executable?: unknown };
      if (typeof manifest.executable !== 'string') throw new Error('Quota publication inputs unavailable');
      pin(profile.command[0]!); pin(manifest.executable);
    }
  }
  const result: QuotaEvidenceRejectPins = { scope: 'quota-publication-reject-only', entries: [...entries].sort(([a], [b]) => a.localeCompare(b)) };
  if (Buffer.byteLength(canonical(result)) > 128 * 1024) throw new Error('Quota publication inputs unavailable');
  return result;
}
