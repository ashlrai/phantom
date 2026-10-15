/** Host-owned native observation. This module never reads a provider credential. */
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { resolveAccountsRoot } from '../verse/seats.js';
import { readResourceJson } from '../resources/pool-runtime.js';
import { validateResourceConnectionConfig } from '../resources/connection-monitor.js';
import { readClaudeAccountLocalBinding, resourceAccountProfileDigest, type ClaudeAccountLocalBinding } from '../resources/account-identity-witness.js';
import type { NativeSeatLaunch } from '../resources/native-profile.js';
import { probeClaudeAccountUsage, type ClaudeAccountUsageResult } from '../resources/claude-account-usage.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import type { ClaudeBrokerObservation } from './claude-native-broker.js';

export interface ClaudeNativeBinding {
  launch: NativeSeatLaunch;
  profileDigest: string;
  epochDigest: string;
  localAccountDigest: string | null;
  expectedAccountDigest: string | null;
}
/** The auth status command, not this metadata, establishes the native principal.
 * File epochs fence replacement of the exact launch/profile during an invocation. */
function nativeBindingPath(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4096 && isAbsolute(value) &&
    resolve(value) === value && parse(value).root !== value && [...value].every(character => {
      const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159);
    });
}
function launchStamp(path: string): string[] {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
  return [path, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)];
}
function privateRosterStamp(path: string): string[] {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 511n) !== 384n ||
    realpathSync(path) !== path || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) throw new Error();
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].map(String);
}
/** A local same-call file fence, never native login, billing or OS identity authority. */
function localBindingStillCurrent(binding: ClaudeAccountLocalBinding): boolean {
  try {
    const statePath = binding.launch.nativeStatePath;
    inspectPrivateDirectory(statePath);
    const state = lstatSync(statePath, { bigint: true });
    if (canonical([state.dev, state.ino, state.birthtimeNs, state.mode, state.uid].map(String)) !== binding.nativeStateIdentity) return false;
    const file = join(statePath, '.claude.json');
    if (binding.localEpoch === null) {
      try { lstatSync(file); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    }
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 511n) !== 384n ||
      stat.size < 2n || stat.size > 2n * 1024n * 1024n || realpathSync(file) !== file ||
      typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return false;
    return digest(canonical(['native-auth-file-epoch-v1', [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)])) === binding.localEpoch.epochDigest;
  } catch { return false; }
}
export function readClaudeNativeBinding(cfg: AshlrConfig, seatId: string): ClaudeNativeBinding | null {
  try {
    const accountsRoot = resolveAccountsRoot(cfg);
    const roster = join(accountsRoot, 'connections.json'); const rosterStamp = privateRosterStamp(roster);
    const account = validateResourceConnectionConfig(readResourceJson(roster))
      .accounts.find(row => row.id === seatId && row.provider === 'claude');
    if (!account || account.command.length !== 2 || !account.command.every(nativeBindingPath) ||
      basename(account.command[1]!) !== 'launcher.mjs') return null;
    const manifest = join(dirname(account.command[1]!), 'profile.json');
    // This bounded hint authorizes nothing: the actual late resolver below
    // validates its whole pristine profile and independently observes OS/APFS.
    const hint = readResourceJson(manifest, 64 * 1024);
    if (!hint || typeof hint !== 'object' || Array.isArray(hint) ||
      !nativeBindingPath((hint as Record<string, unknown>).executable)) return null;
    const proposedExecutable = (hint as { executable: string }).executable;
    const paths = [account.command[0]!, account.command[1]!, proposedExecutable, manifest];
    const stamps = paths.map(launchStamp);
    // Keep the independently fresh LATE resolution after the original stamps;
    // only the redundant earlier resolution is removed.
    const local = readClaudeAccountLocalBinding(accountsRoot, account);
    if (!local || local.launch.executable !== proposedExecutable ||
      canonical(local.launch.command) !== canonical(account.command) ||
      canonical(stamps) !== canonical(paths.map(launchStamp))) return null;
    const afterAccount = validateResourceConnectionConfig(readResourceJson(roster))
      .accounts.find(row => row.id === seatId && row.provider === 'claude');
    if (!afterAccount || canonical(afterAccount) !== canonical(account) ||
      canonical(privateRosterStamp(roster)) !== canonical(rosterStamp) || !localBindingStillCurrent(local)) return null;
    return { launch: local.launch, profileDigest: resourceAccountProfileDigest(account),
      epochDigest: digest(canonical(['claude-native-launch-epoch-v1', stamps])),
      localAccountDigest: local.localEpoch?.accountDigest ?? null, expectedAccountDigest: account.expectedAccountHint ?? null };
  } catch { return null; }
}

export function sameClaudeNativeBinding(a: ClaudeNativeBinding, b: ClaudeNativeBinding): boolean {
  return a.profileDigest === b.profileDigest && a.epochDigest === b.epochDigest &&
    canonical(a.launch) === canonical(b.launch) && (a.localAccountDigest === null || b.localAccountDigest === null || a.localAccountDigest === b.localAccountDigest) && a.expectedAccountDigest === b.expectedAccountDigest;
}
export function claudeNativeObservation(binding: ClaudeNativeBinding, report: ClaudeAccountUsageResult,
  runId: string, model: string, nowMs = Date.now()): ClaudeBrokerObservation | null {
  const at = Date.parse(report.startedAt);
  if (report.status !== 'observed' || report.loggedIn !== true || report.authMethod !== 'claude.ai' ||
    report.quotaFresh !== true || report.extraUsageEnabled !== false || !report.accountHint ||
    !/^[a-f0-9]{64}$/.test(report.accountHint) || binding.expectedAccountDigest !== null && binding.expectedAccountDigest !== report.accountHint || binding.localAccountDigest !== null && binding.localAccountDigest !== report.accountHint ||
    !Number.isSafeInteger(at) || at > nowMs || at + 60_000 <= nowMs) return null;
  return { runId, model, seatId: binding.launch.seatId, accountDigest: report.accountHint,
    profileDigest: binding.profileDigest, epochDigest: binding.epochDigest,
    observedAtMs: at, expiresAtMs: at + 60_000, authMethod: 'claude.ai', extraUsageEnabled: false };
}
/** Metadata-only exact profile calls; default source cannot be supplied by a model. */
export async function observeClaudeNativeBinding(cfg: AshlrConfig, seatId: string, runId: string, model: string,
  cwd: string, signal: AbortSignal, admitted: () => boolean): Promise<{binding: ClaudeNativeBinding; observation: ClaudeBrokerObservation} | null> {
  if (signal.aborted || !admitted()) return null;
  const before = readClaudeNativeBinding(cfg, seatId);
  if (!before) return null;
  const report = await probeClaudeAccountUsage({ command: [...before.launch.command], cwd, timeoutMs: 20_000, signal });
  const after = readClaudeNativeBinding(cfg, seatId);
  if (signal.aborted || !admitted() || !after || !sameClaudeNativeBinding(before, after)) return null;
  if (!claudeNativeObservation(before, report, runId, model)) return null;
  const observation = claudeNativeObservation(after, report, runId, model);
  return observation ? { binding: after, observation } : null;
}
