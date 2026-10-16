import { createPublicKey } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { EngineeringAssignmentV1, EngineeringAssignmentVerifier } from './engineering-assignment.js';

export interface CortexBridgeConfig {
  schemaVersion: 1; url: string; organizationId: string; tokenEnv: string; root: string;
  verifier: EngineeringAssignmentVerifier;
  repositories: Array<{ repository: string; path: string; workstreams: EngineeringAssignmentV1['workstream'][] }>;
  runtimes: Array<'codex'>;
  budget: { maxTokens: number; maxSteps: number; allowCloud: boolean };
}
type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Json, names: string[]): boolean => Object.keys(v).sort().join(',') === names.sort().join(',');
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(v);
const integer = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max;
const workstreams = ['personal', 'company', 'govcon', 'commercial'];
function requireFact(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

/** Project MCP configuration is not admitted by the foreground bridge. */
export function assertNoCortexProjectConfig(repo: string): void {
  try { lstatSync(join(repo, '.codex')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('Cortex bridge cannot run a repository with project .codex configuration');
}

export function parseCortexBridgeConfig(raw: unknown): CortexBridgeConfig {
  requireFact(record(raw) && keys(raw, ['schemaVersion', 'url', 'organizationId', 'tokenEnv', 'root', 'verifier', 'repositories', 'runtimes', 'budget']), 'Invalid Cortex configuration');
  requireFact(raw.schemaVersion === 1 && id(raw.organizationId) && typeof raw.url === 'string' &&
    typeof raw.tokenEnv === 'string' && /^CORTEX_[A-Z0-9_]{0,80}TOKEN$/.test(raw.tokenEnv) &&
    typeof raw.root === 'string' && isAbsolute(raw.root), 'Invalid Cortex identity or storage');
  const url = new URL(raw.url);
  requireFact(url.protocol === 'https:' && !url.username && !url.password && raw.url === url.origin, 'Cortex requires an exact HTTPS origin');
  requireFact(record(raw.verifier) && keys(raw.verifier, ['issuer', 'audience', 'publicKeys']) &&
    id(raw.verifier.issuer) && id(raw.verifier.audience) && record(raw.verifier.publicKeys) &&
    Object.keys(raw.verifier.publicKeys).length >= 1 && Object.keys(raw.verifier.publicKeys).length <= 8 &&
    Object.entries(raw.verifier.publicKeys).every(([key, pem]) => id(key) && typeof pem === 'string' && pem.length <= 4000 &&
      pem.startsWith('-----BEGIN PUBLIC KEY-----\n')), 'Invalid Cortex public key pin');
  for (const pem of Object.values(raw.verifier.publicKeys)) {
    const publicKey = createPublicKey(pem as string);
    requireFact(publicKey.asymmetricKeyType === 'ed25519' && publicKey.export({ format: 'pem', type: 'spki' }).toString() === pem, 'Cortex key pin must be canonical public Ed25519');
  }
  requireFact(Array.isArray(raw.repositories) && raw.repositories.length >= 1 && raw.repositories.length <= 32 && raw.repositories.every(row =>
    record(row) && keys(row, ['repository', 'path', 'workstreams']) && typeof row.repository === 'string' &&
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(row.repository) &&
    typeof row.path === 'string' && isAbsolute(row.path) && Array.isArray(row.workstreams) && row.workstreams.length >= 1 &&
    row.workstreams.every(v => workstreams.includes(String(v)))), 'Invalid Cortex repository map');
  requireFact(new Set(raw.repositories.map(v => v.repository)).size === raw.repositories.length, 'Duplicate Cortex repository');
  requireFact(Array.isArray(raw.runtimes) && raw.runtimes.length === 1 && raw.runtimes[0] === 'codex', 'Cortex engineering assignments currently require Codex only');
  requireFact(record(raw.budget) && keys(raw.budget, ['maxTokens', 'maxSteps', 'allowCloud']) &&
    integer(raw.budget.maxTokens, 200_000) && integer(raw.budget.maxSteps, 40) && typeof raw.budget.allowCloud === 'boolean', 'Invalid Cortex budget');
  return raw as unknown as CortexBridgeConfig;
}

/** Never accepts a symlink or a shared-readable configuration containing local identity. */
export function readCortexBridgeConfig(path: string): CortexBridgeConfig {
  requireFact(isAbsolute(path), 'Cortex configuration requires an absolute path');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    requireFact(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 &&
      (process.getuid === undefined || stat.uid === process.getuid()) && (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'Cortex configuration must be private');
    return parseCortexBridgeConfig(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}
