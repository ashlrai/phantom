/** Read-only preparation for explicit new enrollment. No writable migration exists here. */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { validateResourceConnectionConfig } from './connection-monitor.js';
import { consoleProof } from './pool-evolution.js';
import { decodeResourceConsoleState } from './pool-supervisor.js';
import { decodeResourcePoolState } from './pool-runtime.js';
import { resourcePoolConfigSnapshot, validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import { resolveNativeSeatLaunch } from './native-profile.js';
import { validateResourceQuotaRefreshConfig } from './quota-refresh.js';
import { resourceQuotaBuckets } from './quota-scope.js';
import { assertOfflineResourcePoolCommissioningHistory } from './pool-commissioning-custody.js';

const MAX_BYTES = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
export type ResourcePoolCommissioningCheckCode = 'invalid-input' | 'ownership-present' | 'uncertain-work' |
  'state-unavailable' | 'config-conflict' | 'enrollment-invalid' | 'profile-invalid' | 'state-changed';
/** Fixed diagnostics deliberately exclude paths, identities and private contents. */
export class ResourcePoolCommissioningCheckError extends Error {
  constructor(readonly code: ResourcePoolCommissioningCheckCode) {
    super(`Pool commissioning check held: ${code}`); this.name = 'ResourcePoolCommissioningCheckError';
  }
}
export interface ResourcePoolCommissioningCheckRequest {
  root: string; workspace: string; accountsRoot: string;
  acknowledgment: 'new-roster-enrollment-without-continuity';
  enrollments: Array<{ capacityKey: string; seatId: string }>;
}
export const RESOURCE_POOL_COMMISSIONING_APPLICATION_HOLDS = [
  'account-identity-continuity-unverified',
  'fresh-target-collector-evidence-required',
  'current-account-quota-and-billing-qualification-required',
] as const;
export interface ResourcePoolCommissioningCheckPlan {
  schemaVersion: 1; status: 'planned'; planDigest: string;
  fromPoolDigest: string; targetPoolDigest: string; rosterDigest: string;
  configurationDisposition: 'active' | 'historical'; historyCount: number; preservedReceiptCount: number;
  preservedJobCount: number; heldQueuedIds: string[]; invalidatedWorkerIds: string[];
  proposedCapacities: Array<{ capacityKey: string; seatId: string; provider: string; workerIds: string[]; profileMetadataDigest: string }>;
  preservationDigest: string; targetConfigurationDigest: string; targetConsoleDigest: string; targetConsoleProofDigest: string;
  applicationHolds: readonly string[]; applicationReady: false; applicationImplemented: true;
  identityContinuityVerified: false; independentAccountIdentityVerified: false;
  executionAuthorized: false; providerContacted: false; stateChanged: false;
}
function refuse(code: ResourcePoolCommissioningCheckCode): never { throw new ResourcePoolCommissioningCheckError(code); }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function path(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 4096 && isAbsolute(v) && resolve(v) === v && v !== parse(v).root &&
    [...v].every(c => c.charCodeAt(0) >= 32 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159));
}
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
function outside(workspace: string, file: string): boolean {
  const nested = relative(workspace, file);
  return nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested);
}
export function validateResourcePoolCommissioningRequest(value: unknown): ResourcePoolCommissioningCheckRequest {
  const encoded = canonicalEvidencePackJsonV3(value);
  if (encoded === null || Buffer.byteLength(encoded) > 64 * 1024) return refuse('invalid-input');
  const v: unknown = JSON.parse(encoded);
  if (!exact(v, ['root', 'workspace', 'accountsRoot', 'acknowledgment', 'enrollments']) ||
    !path(v.root) || !path(v.workspace) || !path(v.accountsRoot) || v.root !== join(v.accountsRoot, 'ledger') ||
    !outside(v.workspace, v.accountsRoot) || v.acknowledgment !== 'new-roster-enrollment-without-continuity' ||
    !Array.isArray(v.enrollments) || !v.enrollments.length || v.enrollments.length > 64 ||
    !v.enrollments.every(row => exact(row, ['capacityKey', 'seatId']) && typeof row.capacityKey === 'string' && ID.test(row.capacityKey) &&
      typeof row.seatId === 'string' && ID.test(row.seatId)) ||
    new Set(v.enrollments.map(row => row.capacityKey)).size !== v.enrollments.length ||
    new Set(v.enrollments.map(row => row.seatId)).size !== v.enrollments.length) return refuse('invalid-input');
  return v as unknown as ResourcePoolCommissioningCheckRequest;
}
function offline(root: string): void {
  if (['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'].some(name => present(join(root, name)))) refuse('ownership-present');
  if (present(join(root, '.resource-quota-refresh-pending.json'))) refuse('uncertain-work');

}
interface CapturedFile { text: string; identity: string }
function file(filePath: string, anchor: string): CapturedFile {
  const stat = lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n ||
    typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return refuse('state-unavailable');
  const read = readStableRegularFile(filePath, { anchorPath: anchor, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!read.ok) return refuse('state-unavailable');
  const identity = canonical([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink].map(String));
  return { text: read.text, identity };
}
function hash(v: unknown): string { return digest(canonical(v)); }
function directoryIdentity(directory: string): string {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
    typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return refuse('state-unavailable');
  return canonical([stat.dev, stat.ino, stat.uid, stat.mode, stat.birthtimeNs].map(String));
}

/** Offline check only. A valid plan is inert preparation, never commissioning custody or account evidence. */
export function checkResourcePoolCommissioning(value: unknown): ResourcePoolCommissioningCheckPlan {
  try { return prepareResourcePoolCommissioning(value).plan; }
  catch (e) { if (e instanceof ResourcePoolCommissioningCheckError) throw e; return refuse('state-unavailable'); }
}
/** Internal bounded snapshots for the offline transaction; does not write or acquire ownership. */
export function prepareResourcePoolCommissioning(value: unknown) {
  const input = validateResourcePoolCommissioningRequest(value);
  inspectPrivateDirectory(input.accountsRoot); inspectPrivateDirectory(input.root); offline(input.root);
  const directoryPins = [input.accountsRoot, input.root, input.workspace].map(path => ({ path, identity: directoryIdentity(path) }));
  const captured = new Map<string, { anchor: string; file: CapturedFile }>();
  const read = (name: string, anchor: string, optional = false, parseJson = true): unknown => {
    if (optional && !present(name)) return null;
    const loaded = file(name, anchor); captured.set(name, { anchor, file: loaded }); return parseJson ? JSON.parse(loaded.text) as unknown : loaded.text;
  };
  const ledger = read(join(input.root, 'pool-state.json'), input.root);
  if (!record(ledger) || ledger.schemaVersion !== 2 || ledger.pendingEvolution !== undefined) refuse('state-unavailable');
  const history = validateResourcePoolConfigHistory(ledger.configurationHistory);
  const active = history.at(-1)!;
  const state = decodeResourcePoolState(ledger, active.pool, active.bindings);
  assertOfflineResourcePoolCommissioningHistory(input.root, state);
  if (state.attempts.some(row => row.status === 'reserved' || row.status === 'uncertain')) refuse('uncertain-work');
  const pool = read(join(input.accountsRoot, 'pool.json'), input.accountsRoot);
  const bindings = read(join(input.accountsRoot, 'bindings.json'), input.accountsRoot);
  const selected = resourcePoolConfigSnapshot(pool, bindings);
  if (!history.some(row => row.poolDigest === selected.poolDigest && canonical(row.pool) === canonical(selected.pool) && canonical(row.bindings) === canonical(selected.bindings))) refuse('config-conflict');
  const quotaValue = read(join(input.accountsRoot, 'quota-config.json'), input.accountsRoot);
  const quota = validateResourceQuotaRefreshConfig(quotaValue, selected.pool, selected.bindings);
  const rosterValue = read(join(input.accountsRoot, 'connections.json'), input.accountsRoot);
  const roster = validateResourceConnectionConfig(rosterValue);
  const consoleValue = read(join(input.root, 'resource-console-state.json'), input.root, true);
  const console = consoleValue === null ? null : decodeResourceConsoleState(consoleValue,
    { workspace: input.workspace, pool: active.pool, bindings: active.bindings, configHistory: history });
  if (console?.jobs.some(row => row.state === 'dispatching' || row.state === 'unresolved')) refuse('uncertain-work');
  const nextBindings = structuredClone(active.bindings);
  const capacities: ResourcePoolCommissioningCheckPlan['proposedCapacities'] = [];
  const hints = new Map<string, string>();
  for (const enrollment of input.enrollments) {
    const aliases = nextBindings.filter(row => row.capacityKey === enrollment.capacityKey);
    const workers = aliases.map(row => active.pool.workers.find(w => w.id === row.workerId)!);
    if (!aliases.length || aliases.some(row => row.kind !== 'native-cli') ||
      workers.some(w => w.provider !== workers[0]!.provider) || !['codex', 'claude'].includes(workers[0]!.provider)) refuse('enrollment-invalid');
    const provider = workers[0]!.provider as 'codex' | 'claude';
    const seat = roster.accounts.find(row => row.id === enrollment.seatId && row.provider === provider);
    if (!seat) refuse('enrollment-invalid');
    const launch = resolveNativeSeatLaunch({ accountsRoot: input.accountsRoot, provider, seatId: seat.id });
    if (!launch.ok || canonical(launch.launch.command) !== canonical(seat.command)) refuse('profile-invalid');
    const profile = read(join(dirname(seat.command[1]!), 'profile.json'), dirname(seat.command[1]!));
    if (!record(profile) || profile.schemaVersion !== 2 || !record(profile.identity)) refuse('profile-invalid');
    const launcher = read(join(dirname(seat.command[1]!), 'launcher.mjs'), dirname(seat.command[1]!), false, false);
    const commandFile = read(join(dirname(seat.command[1]!), 'command.json'), dirname(seat.command[1]!));
    if (aliases.every(row => row.kind === 'native-cli' && canonical(row.command) === canonical(seat.command))) refuse('enrollment-invalid');
    for (const alias of aliases) if (alias.kind === 'native-cli') alias.command = [...seat.command];
    if (provider === 'codex') {
      if (!seat.expectedAccountHint || !HASH.test(seat.expectedAccountHint)) refuse('enrollment-invalid');
      hints.set(enrollment.capacityKey, seat.expectedAccountHint);
    }
    capacities.push({ capacityKey: enrollment.capacityKey, seatId: seat.id, provider, workerIds: aliases.map(a => a.workerId),
      profileMetadataDigest: hash({ profile, command: seat.command, launcher, commandFile }) });
  }
  // Locator/hint uniqueness is an operational deduplication check, never independent account proof.
  for (const a of nextBindings) for (const b of nextBindings) {
    if (a.capacityKey !== b.capacityKey && a.kind === 'native-cli' && b.kind === 'native-cli' && canonical(a.command) === canonical(b.command)) refuse('enrollment-invalid');
  }
  for (const row of quota.workers) {
    const binding = selected.bindings.find(b => b.workerId === row.workerId)!;
    if (!hints.has(binding.capacityKey)) hints.set(binding.capacityKey, row.accountHint);
  }
  if (new Set(hints.values()).size !== hints.size) refuse('enrollment-invalid');
  const target = resourcePoolConfigSnapshot(active.pool, nextBindings);
  const nextQuota = validateResourceQuotaRefreshConfig({ schemaVersion: 1, poolDigest: target.poolDigest,
    workers: active.pool.workers.filter(w => w.provider === 'codex').map(w => {
      const binding = nextBindings.find(b => b.workerId === w.id)!;
      const buckets = resourceQuotaBuckets(w) ?? quota.workers.find(row => row.workerId === w.id)?.bucketIds;
      const hint = hints.get(binding.capacityKey);
      if (!buckets || !hint) return refuse('enrollment-invalid');
      return { workerId: w.id, accountHint: hint, bucketIds: buckets };
    }) }, active.pool, nextBindings);
  // Recheck all exact bytes/identities and metadata after planning. No leases or writes.
  offline(input.root);
  for (const [name, original] of captured) {
    const current = file(name, original.anchor);
    if (current.text !== original.file.text || current.identity !== original.file.identity) refuse('state-changed');
  }
  if (consoleValue === null && present(join(input.root, 'resource-console-state.json'))) refuse('state-changed');
  for (const enrollment of capacities) if (!resolveNativeSeatLaunch({ accountsRoot: input.accountsRoot,
    provider: enrollment.provider as 'codex' | 'claude', seatId: enrollment.seatId }).ok) refuse('profile-invalid');
  offline(input.root);
  if (directoryPins.some(row => directoryIdentity(row.path) !== row.identity)) refuse('state-changed');
  const nextConsole = console === null ? null : { ...console, schemaVersion: 5 as const, originPoolDigest: console.originPoolDigest ?? active.poolDigest };
  const report = {
    schemaVersion: 1 as const, status: 'planned' as const, fromPoolDigest: active.poolDigest, targetPoolDigest: target.poolDigest,
    rosterDigest: hash(rosterValue), configurationDisposition: selected.poolDigest === active.poolDigest ? 'active' as const : 'historical' as const,
    historyCount: history.length, preservedReceiptCount: state.attempts.length, preservedJobCount: console?.jobs.length ?? 0,
    heldQueuedIds: console?.jobs.filter(row => row.state === 'queued').map(row => row.id) ?? [],
    invalidatedWorkerIds: capacities.flatMap(row => row.workerIds), proposedCapacities: capacities,
    preservationDigest: hash({ stateDigest: hash(state), consoleDigest: hash(consoleValue) }),
    targetConsoleDigest: hash(nextConsole), targetConsoleProofDigest: hash(consoleProof(nextConsole)), targetConfigurationDigest: hash({ target, quota: nextQuota }),
    applicationHolds: [...RESOURCE_POOL_COMMISSIONING_APPLICATION_HOLDS], applicationReady: false as const, applicationImplemented: true as const,
    identityContinuityVerified: false as const, independentAccountIdentityVerified: false as const,
    executionAuthorized: false as const, providerContacted: false as const, stateChanged: false as const,
  };
  const planBasis = { input, report, directoryPins, sourceFiles: [...captured].map(([name, row]) => ({ path: name,
    identity: row.file.identity, contentDigest: digest(row.file.text) })) };
  const plan = { ...report, planDigest: hash(planBasis) };
  return { input, plan, planBasis, active, state, console, consoleValue, target, nextQuota, captured, directoryPins };
}
