/** Internal identity evidence. None of these digests are credentials or public account names. */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { resolveNativeSeatDisplayMetadata, resolveNativeSeatLaunch } from './native-profile.js';
import { readResourceJson } from './pool-runtime.js';
import type { ResourceConnectionConfig } from './connection-monitor.js';

export interface ResourceAccountIdentityWitness {
  provider: 'codex' | 'claude' | 'grok';
  accountId: string;
  accountDigest: string;
  profileDigest: string;
  generation: number;
  observedAt: string;
  expiresAt: string;
  source: 'native-account-checked' | 'native-account-checked-local-epoch';
}
export interface ResourceAccountLocalEpoch { profileDigest: string; epochDigest: string; accountDigest?: string }
/** The same file-epoch digest, resolved with a possibly 60 s old APFS volume read. Its digest
 * field is deliberately named differently, so it is not assignable to ResourceAccountLocalEpoch
 * (the witness input); it only qualifies historical display. */
export interface ResourceAccountDisplayEpoch { scope: 'historical-display-only'; profileDigest: string; displayEpochDigest: string; accountDigest?: string }
export interface ResourceAccountIdentitySnapshot {
  witness: ResourceAccountIdentityWitness;
  localEpoch: ResourceAccountLocalEpoch | null;
}
export function resourceIdentityInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validResourceAccountIdentityWitness(value: unknown, nowMs = Date.now()): value is ResourceAccountIdentityWitness {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as ResourceAccountIdentityWitness;
    const keys = ['provider', 'accountId', 'accountDigest', 'profileDigest', 'generation', 'observedAt', 'expiresAt', 'source'];
    return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) &&
      'value' in Object.getOwnPropertyDescriptor(value, key)!) && ['codex', 'claude', 'grok'].includes(row.provider) &&
      typeof row.accountId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.accountId) &&
      typeof row.accountDigest === 'string' && /^[a-f0-9]{64}$/.test(row.accountDigest) &&
      typeof row.profileDigest === 'string' && /^[a-f0-9]{64}$/.test(row.profileDigest) &&
      Number.isSafeInteger(row.generation) && row.generation > 0 && resourceIdentityInstant(row.observedAt) &&
      resourceIdentityInstant(row.expiresAt) && Date.parse(row.observedAt) <= nowMs && Date.parse(row.expiresAt) > nowMs &&
      Date.parse(row.expiresAt) - Date.parse(row.observedAt) <= 60_000 &&
      ['native-account-checked', 'native-account-checked-local-epoch'].includes(row.source);
  } catch { return false; }
}
/** Generation fences writes; the stable tuple is the identity used by persistent display records. */
export function sameResourceAccountIdentity(a: ResourceAccountIdentityWitness, b: ResourceAccountIdentityWitness): boolean {
  return a.provider === b.provider && a.accountId === b.accountId && a.accountDigest === b.accountDigest && a.profileDigest === b.profileDigest;
}
export function resourceAccountProfileDigest(account: ResourceConnectionConfig['accounts'][number]): string {
  return digest(canonical(['resource-reading-profile-v1', account.id, account.provider, account.command, account.expectedAccountHint ?? null]));
}
/** No credential contents are read. Only an unchanged, private file epoch paired with a
 * prior successful native account check can witness historical identity across restart.
 * Claude's pinned .claude.json supplies local OAuth account metadata, not keychain
 * authentication. Matching it qualifies historical display only, never a current login. */
export function readResourceAccountLocalEpoch(accountsRoot: string, account: ResourceConnectionConfig['accounts'][number]): ResourceAccountLocalEpoch | null {
  try {
    const result = resolveNativeSeatLaunch({ accountsRoot, provider: account.provider, seatId: account.id });
    return result.ok ? readEpochFields(account, result.launch.command, result.launch.nativeStatePath) : null;
  } catch { return null; }
}
/** Display-only twin: identical file checks, volume identity may be up to 60 s old. Never
 * feeds witness(), captureEpoch, remember or recheckResourceAccountIdentitySnapshot. */
export function readResourceAccountDisplayEpoch(accountsRoot: string, account: ResourceConnectionConfig['accounts'][number]): ResourceAccountDisplayEpoch | null {
  try {
    const seat = resolveNativeSeatDisplayMetadata({ accountsRoot, provider: account.provider, seatId: account.id });
    const fields = seat ? readEpochFields(account, seat.command, seat.nativeStatePath) : null;
    return fields ? { scope: 'historical-display-only', profileDigest: fields.profileDigest, displayEpochDigest: fields.epochDigest,
      ...(fields.accountDigest === undefined ? {} : { accountDigest: fields.accountDigest }) } : null;
  } catch { return null; }
}
function readEpochFields(account: ResourceConnectionConfig['accounts'][number], command: readonly string[], nativeStatePath: string): ResourceAccountLocalEpoch | null {
  try {
    if (canonical(command) !== canonical(account.command)) return null;
    inspectPrivateDirectory(nativeStatePath);
    const file = join(nativeStatePath, account.provider === 'claude' ? '.claude.json' : 'auth.json');
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 511n) !== 384n ||
      stat.size < 2n || stat.size > 2n * 1024n * 1024n || realpathSync(file) !== file ||
      typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return null;
    let accountDigest: string | undefined;
    if (account.provider === 'claude') {
      const value = readResourceJson(file);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const oauth = (value as Record<string, unknown>).oauthAccount;
      if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
      const { emailAddress, organizationUuid } = oauth as Record<string, unknown>;
      const safe = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 4096 &&
        [...v].every(c => { const code = c.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); });
      if (!safe(emailAddress) || !safe(organizationUuid)) return null;
      // Exact twin of Claude auth-status's existing private account-hint formula.
      accountDigest = digest(JSON.stringify(['claude-native-auth-v1', emailAddress, organizationUuid]));
    }
    const after = lstatSync(file, { bigint: true });
    const epoch = (s: typeof stat) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
    if (canonical(epoch(stat)) !== canonical(epoch(after))) return null;
    return { profileDigest: resourceAccountProfileDigest(account), epochDigest: digest(canonical(['native-auth-file-epoch-v1', epoch(stat)])),
      ...(accountDigest === undefined ? {} : { accountDigest }) };
  } catch { return null; }
}

/** Worker-side metadata fence for a host's pure in-memory snapshot. No provider
 * request or identity refresh. Unknown local binding cannot validate an amount. */
export function recheckResourceAccountIdentitySnapshot(accountsRoot: string, account: ResourceConnectionConfig['accounts'][number],
  snapshot: ResourceAccountIdentitySnapshot, nowMs = Date.now()): ResourceAccountIdentityWitness | null {
  try {
    const w = snapshot.witness; const captured = snapshot.localEpoch;
    if (!validResourceAccountIdentityWitness(w, nowMs) || w.source !== 'native-account-checked' || w.provider !== account.provider ||
      w.accountId !== account.id || w.profileDigest !== resourceAccountProfileDigest(account) || !captured) return null;
    const current = readResourceAccountLocalEpoch(accountsRoot, account);
    return current && canonical(current) === canonical(captured) &&
      (current.accountDigest === undefined || current.accountDigest === w.accountDigest) ? structuredClone(w) : null;
  } catch { return null; }
}
