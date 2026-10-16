/** Owner-approved foreground authority. Never writes shared-machine enrollment. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assertNoCortexProjectConfig, parseCortexBridgeConfig, type CortexBridgeConfig } from './config.js';
import { parseEngineeringAssignmentV1 } from './engineering-assignment.js';

export type CortexAdmissionPurpose = 'produce' | 'verify';
/** Runtime authority lives only in the private WeakMap, never in these bytes. */
export interface CortexAdmissionToken { readonly __cortexAdmission?: never }
type Identity = { path: string; dev: string; ino: string };
type FilePin = Identity & { size: string; mtime: string; ctime: string; sha256: string };
type RepoPin = { repository: string; directory: Identity; commonGitDirectory: Identity; sourceCommit: string; origin: string };
interface AdmissionRecord {
  protocol: 'ashlr-cortex-foreground-admission/v1'; admissionId: string; createdAt: string;
  config: FilePin; configDirectory: Identity; recordsDirectory: Identity; implementationSha256: string;
  organizationId: string; origin: string; workstream: 'company'; repositories: RepoPin[];
}
interface Snapshot { config: CortexBridgeConfig; configPin: FilePin; record: AdmissionRecord; recordPin: FilePin }
interface Scope {
  active: boolean; snapshot: Snapshot; repo: RepoPin; expiresAt: number; controller: AbortController;
}
const scopes = new AsyncLocalStorage<Scope>();
const tokens = new WeakMap<CortexAdmissionToken, { scope: Scope; purpose: CortexAdmissionPurpose }>();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function demand(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Cortex admission: ${reason}`); }
function git(path: string, args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function contains(parent: string, child: string): boolean {
  const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function directory(path: string): Identity {
  demand(isAbsolute(path) && realpathSync(path) === path, 'directory must be a physical absolute path');
  const stat = lstatSync(path, { bigint: true }); demand(stat.isDirectory() && !stat.isSymbolicLink(), 'directory identity is unavailable');
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}
function privateFile(path: string): { bytes: Buffer; pin: FilePin } {
  demand(isAbsolute(path) && realpathSync(path) === path, 'file must be a physical absolute path');
  inspectPrivateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    demand(stat.isFile() && stat.nlink === 1n && stat.size <= 64n * 1024n &&
      (process.getuid === undefined || stat.uid === BigInt(process.getuid())) && (stat.mode & 0o077n) === 0n,
    'file must be private, singly linked and owned by the operator');
    const bytes = readFileSync(fd); const after = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true });
    demand(stat.dev === after.dev && stat.ino === after.ino && stat.size === after.size && stat.mtimeNs === after.mtimeNs && stat.ctimeNs === after.ctimeNs &&
      named.dev === stat.dev && named.ino === stat.ino && named.size === stat.size && named.mtimeNs === stat.mtimeNs && named.ctimeNs === stat.ctimeNs &&
      named.isFile() && !named.isSymbolicLink(), 'file changed while being read');
    return { bytes, pin: { path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), sha256: sha(bytes) } };
  } finally { closeSync(fd); }
}
export function cortexAdmissionPath(configPath: string): string { return join(dirname(configPath), `.${basename(configPath)}.cortex-admission.json`); }
function configuration(configPath: string) {
  demand(process.platform !== 'win32', 'foreground admission requires POSIX owner/private-file enforcement');
  const loaded = privateFile(configPath); const config = parseCortexBridgeConfig(JSON.parse(loaded.bytes.toString('utf8')));
  inspectPrivateDirectory(config.root); demand(realpathSync(config.root) === config.root, 'records root must be physical');
  demand(config.repositories.length === 1, 'one explicit Company repository is supported per admission');
  demand(config.repositories.every(r => r.workstreams.length === 1 && r.workstreams[0] === 'company'), 'only Company repository policy may be admitted');
  for (const row of config.repositories) {
    demand(!contains(row.path, configPath) && !contains(row.path, cortexAdmissionPath(configPath)) && !contains(row.path, config.root) && !contains(config.root, row.path),
      'configuration, admission and records must be outside every execution repository');
  }
  return { config, configPin: loaded.pin };
}
function implementationSha256(): string {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const paths = ['admission', 'config', 'bridge', 'codex-policy', 'codex-runtime', 'engineering-assignment', '../sandbox/policy', '../sandbox/worktree',
    '../run/orchestrator', '../run/sandboxed-engine', '../inbox/merge', '../authority/protected-paths', '../types', '../../cli/cortex'];
  const digest = createHash('sha256');
  for (const path of paths) { digest.update(path); digest.update(readFileSync(fileURLToPath(new URL(`${path}${extension}`, import.meta.url)))); }
  // Bind package release identity too, so unrelated release upgrades still need operator admission.
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  digest.update(readFileSync(join(root, 'package.json')));
  try { digest.update(readFileSync(join(root, 'dist/build-identity.json'))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return digest.digest('hex');
}
function recognizedRecord(value: unknown, configPath: string): value is AdmissionRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as AdmissionRecord;
  const identity = (pin: Identity | undefined): boolean => !!pin && typeof pin.path === 'string' && isAbsolute(pin.path) &&
    /^\d+$/.test(pin.dev ?? '') && /^\d+$/.test(pin.ino ?? '');
  const file = (pin: FilePin | undefined) => identity(pin) && /^\d+$/.test(pin!.size ?? '') &&
    /^\d+$/.test(pin!.mtime ?? '') && /^\d+$/.test(pin!.ctime ?? '') && /^[0-9a-f]{64}$/.test(pin!.sha256 ?? '');
  return r.protocol === 'ashlr-cortex-foreground-admission/v1' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.admissionId ?? '') &&
    typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) && r.config?.path === configPath &&
    file(r.config) && identity(r.configDirectory) && r.configDirectory.path === dirname(configPath) && identity(r.recordsDirectory) &&
    /^[0-9a-f]{64}$/.test(r.implementationSha256 ?? '') && typeof r.organizationId === 'string' &&
    r.organizationId.length > 0 && typeof r.origin === 'string' && /^https:\/\//.test(r.origin) && r.workstream === 'company' &&
    Array.isArray(r.repositories) && r.repositories.length === 1 && r.repositories.every(repo => repo &&
      /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(repo.repository ?? '') && identity(repo.directory) && identity(repo.commonGitDirectory) &&
      /^[0-9a-f]{40}$/.test(repo.sourceCommit ?? '') && typeof repo.origin === 'string' && repo.origin.length > 0);
}
function repository(repository: string, path: string): RepoPin {
  const identity = directory(path); assertNoCortexProjectConfig(path);
  demand(git(path, ['rev-parse', '--show-toplevel']) === path && !git(path, ['status', '--porcelain']), 'repository must be a clean physical Git root');
  const origin = git(path, ['remote', 'get-url', 'origin']);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(origin);
  demand(match?.[1]?.toLowerCase() === repository, 'GitHub origin does not match configured repository');
  const sourceCommit = git(path, ['rev-parse', 'HEAD']); demand(/^[0-9a-f]{40}$/.test(sourceCommit), 'source commit is unavailable');
  const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { repository, directory: identity, commonGitDirectory: directory(realpathSync(common)), sourceCommit, origin };
}
function currentRecord(configPath: string): Snapshot {
  const loaded = configuration(configPath); const stored = privateFile(cortexAdmissionPath(configPath));
  const record = JSON.parse(stored.bytes.toString('utf8')) as AdmissionRecord;
  demand(recognizedRecord(record, configPath) &&
    record.workstream === 'company' && record.organizationId === loaded.config.organizationId && record.origin === loaded.config.url &&
    same(record.config, loaded.configPin) && Array.isArray(record.repositories) && record.repositories.length === loaded.config.repositories.length,
  'record or configuration binding changed; explicitly revoke and admit again');
  demand(same(record.configDirectory, directory(dirname(configPath))) && same(record.recordsDirectory, directory(loaded.config.root)) &&
    record.implementationSha256 === implementationSha256(), 'admission storage or implementation changed; explicitly admit again');
  for (const [index, row] of loaded.config.repositories.entries()) {
    demand(same(record.repositories[index], repository(row.repository, row.path)), 'repository/source policy changed; explicitly admit again');
  }
  return { ...loaded, record, recordPin: stored.pin };
}
/** Explicit operator opt-in only. Existing records are never silently refreshed. */
export function admitCortexConfiguration(configPath: string) {
  const loaded = configuration(configPath); const path = cortexAdmissionPath(configPath);
  try { lstatSync(path); throw new Error('Cortex admission: existing record must be explicitly revoked first'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const record: AdmissionRecord = { protocol: 'ashlr-cortex-foreground-admission/v1', admissionId: randomUUID(), createdAt: new Date().toISOString(),
    config: loaded.configPin, configDirectory: directory(dirname(configPath)), recordsDirectory: directory(loaded.config.root), implementationSha256: implementationSha256(),
    organizationId: loaded.config.organizationId, origin: loaded.config.url, workstream: 'company',
    repositories: loaded.config.repositories.map(r => repository(r.repository, r.path)) };
  // Recheck before exclusive persistence; concurrent admits cannot replace one another.
  demand(same(configuration(configPath).configPin, loaded.configPin), 'configuration changed during admission');
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`); demand(bytes.length <= 64 * 1024, 'record exceeds byte bounds');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    let offset = 0; while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); demand(written > 0, 'record write made no progress'); offset += written; }
    fchmodSync(fd, 0o600); fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
  currentRecord(configPath);
  return { state: 'admitted' as const, admissionId: record.admissionId, recordPath: path, executionStarted: false, sharedEnrollmentChanged: false };
}
/** Removing this private record revokes active bridge scopes without touching global eligibility. */
export function revokeCortexConfiguration(configPath: string) {
  demand(isAbsolute(configPath) && realpathSync(dirname(configPath)) === dirname(configPath), 'revocation requires the original physical configuration path');
  const path = cortexAdmissionPath(configPath); const loaded = privateFile(path);
  demand(recognizedRecord(JSON.parse(loaded.bytes.toString('utf8')), configPath), 'refusing to remove an unrecognized or foreign record');
  demand(same(privateFile(path).pin, loaded.pin), 'record changed before revocation');
  unlinkSync(path); fsyncDirectory(dirname(path));
  return { state: 'revoked' as const, sharedEnrollmentChanged: false };
}
export function inspectCortexAdmission(configPath: string) {
  const snapshot = currentRecord(configPath);
  return { config: snapshot.config, admissionId: snapshot.record.admissionId };
}
/** A caller-authored object is not authority: the signed assignment is verified here too. */
export async function withCortexForegroundAdmission<T>(configPath: string, rawAssignment: unknown,
  run: (authority: { producer: CortexAdmissionToken; verifier: CortexAdmissionToken; signal: AbortSignal }) => Promise<T>): Promise<T> {
  demand(scopes.getStore() === undefined, 'nested admission scopes are refused');
  const snapshot = currentRecord(configPath); const assignment = parseEngineeringAssignmentV1(rawAssignment, { verifier: snapshot.config.verifier });
  demand(assignment && assignment.workstream === 'company' && assignment.organizationRef === snapshot.config.organizationId &&
    assignment.authority.requiredTenantRef === snapshot.config.organizationId, 'a current signed Company assignment is required');
  const repo = snapshot.record.repositories.find(r => r.repository === `${assignment.repo.owner}/${assignment.repo.name}`);
  demand(repo && repo.sourceCommit === assignment.repo.sourceCommit, 'assignment repository/source is not admitted');
  const scope: Scope = { active: true, snapshot, repo, expiresAt: Date.parse(assignment.expiresAt), controller: new AbortController() };
  const producer = Object.freeze({}); const verifier = Object.freeze({});
  tokens.set(producer, { scope, purpose: 'produce' }); tokens.set(verifier, { scope, purpose: 'verify' });
  return scopes.run(scope, async () => {
    const timer = setInterval(() => { try { assertCortexAdmission(repo.directory.path, producer, 'produce'); } catch { scope.controller.abort(); } }, 500);
    try { return await run({ producer, verifier, signal: scope.controller.signal }); }
    finally { scope.active = false; scope.controller.abort(); clearInterval(timer); tokens.delete(producer); tokens.delete(verifier); }
  });
}
/** Invoked only by explicit producer/verification gates, never by enrollment readers. */
export function assertCortexAdmission(repo: string, token: CortexAdmissionToken, purpose: CortexAdmissionPurpose): void {
  const grant = tokens.get(token); const scope = scopes.getStore();
  demand(grant && scope === grant.scope && scope.active && !scope.controller.signal.aborted && grant.purpose === purpose &&
    repo === scope.repo.directory.path && Date.now() < scope.expiresAt, 'foreground capability is forged, closed, expired or outside its purpose/repository');
  const fresh = currentRecord(scope.snapshot.configPin.path);
  demand(same(fresh.configPin, scope.snapshot.configPin) && same(fresh.recordPin, scope.snapshot.recordPin) && same(fresh.record, scope.snapshot.record),
    'foreground admission was replaced or revoked');
}
