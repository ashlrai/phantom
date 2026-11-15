/**
 * core/connect/transfer.ts: the strict-order grant transfer engine.
 *
 * On approval, access moves in this order, first applicable method wins:
 *
 *   1. device-login    the vendor's own device-code/OAuth login runs on the
 *                      target node (spawned here when local, handed to the
 *                      operator as an exact command when remote).
 *   2. scoped-token    a scoped token minted by the vendor CLI is vaulted in
 *                      Phantom Secrets under a node-scoped name. The value
 *                      travels on stdin; it is never printed, logged or
 *                      persisted outside the vault.
 *   3. session-copy    LAST RESORT. Each session file requires its own
 *                      explicit approval; the approved bytes are sealed into
 *                      an AES-256-GCM bundle under ~/.ashlr/connect/bundles/
 *                      and the data key is vaulted in Phantom Secrets. The
 *                      CMP Codex session (~/.codex) is structurally excluded.
 *
 * Every method tried records a value-free ConnectAttempt on the grant.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import {
  ensureConnectDirectory,
  connectBundlesDir,
} from './store.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';
import { getConnectService, isExcludedSessionPath, sessionCopyRefusal } from './services.js';
import { isLocalNode, newGrantId } from './requests.js';
import type {
  ConnectAttempt,
  ConnectDeps,
  ConnectGrant,
  ConnectServiceId,
  ConnectTransferMethod,
} from './types.js';
import { CONNECT_METHOD_ORDER } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectTransferInput {
  service: ConnectServiceId;
  node: string;
  account: string | null;
  scopes: string[];
  /** Narrow the transfer to one method (still gated by every rule). */
  requestedMethod?: ConnectTransferMethod | null;
  requestId?: string | null;
  /**
   * Per-item approval for session-copy. MUST be wired to an explicit human
   * confirmation; when absent the session-copy method is unavailable.
   */
  confirmSessionFile?: (relPath: string) => Promise<boolean>;
}

export interface ConnectTransferResult {
  ok: boolean;
  grant?: ConnectGrant;
  /** Value-free refusal detail when ok === false. */
  reason?: string;
  attempts: ConnectAttempt[];
  /** For delivery 'operator-command': the exact login to run on the node. */
  operatorCommand?: string;
}

// ---------------------------------------------------------------------------
// Secret naming (names are metadata; values never leave the vault)
// ---------------------------------------------------------------------------

function sanitizeNamePart(part: string): string {
  return part.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'X';
}

export function connectSecretName(service: ConnectServiceId, node: string): string {
  return `PHM_CONNECT_${sanitizeNamePart(service)}_${sanitizeNamePart(node)}`;
}

function connectBundleKeyName(grantId: string): string {
  return `PHM_CONNECT_BUNDLE_${sanitizeNamePart(grantId)}`;
}

// ---------------------------------------------------------------------------
// Session-file collection (existence checks only; contents read at seal time)
// ---------------------------------------------------------------------------

export interface CollectedSessionFile {
  /** Home-relative path as displayed to the approver. */
  rel: string;
  absolute: string;
  mode: number;
  size: number;
}

const SESSION_FILE_MAX_BYTES = 256 * 1024;
const SESSION_DIR_MAX_FILES = 64;
const SESSION_DIR_MAX_DEPTH = 3;
const SESSION_TOTAL_MAX_BYTES = 1024 * 1024;

function isSafeRegularFile(absolute: string): { ok: boolean; mode: number; size: number } {
  try {
    const st = lstatSync(absolute);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, mode: 0, size: 0 };
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, mode: 0, size: 0 };
    if (st.size <= 0 || st.size > SESSION_FILE_MAX_BYTES) return { ok: false, mode: 0, size: 0 };
    return { ok: true, mode: st.mode & 0o777, size: st.size };
  } catch {
    return { ok: false, mode: 0, size: 0 };
  }
}

function collectSessionFiles(home: string, rel: string, depth: number, out: CollectedSessionFile[]): void {
  if (out.length >= SESSION_DIR_MAX_FILES || depth > SESSION_DIR_MAX_DEPTH) return;
  if (isExcludedSessionPath(rel)) return; // hard exception, every level
  const absolute = join(home, rel);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(absolute);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    let names: string[];
    try {
      names = readdirSync(absolute);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      collectSessionFiles(home, join(rel, name), depth + 1, out);
    }
    return;
  }
  const check = isSafeRegularFile(absolute);
  if (check.ok) out.push({ rel, absolute, mode: check.mode, size: check.size });
}

/** Existing, safe, non-excluded session files for a service. Existence only. */
export function listSessionFiles(serviceId: ConnectServiceId, home: string = homedir()): CollectedSessionFile[] {
  const service = getConnectService(serviceId);
  if (!service || service.sessionCopyProhibitedReason !== null) return [];
  const out: CollectedSessionFile[] = [];
  for (const rel of service.sessionFiles) {
    collectSessionFiles(home, rel, 0, out);
  }
  let total = 0;
  return out.filter((f) => {
    total += f.size;
    return total <= SESSION_TOTAL_MAX_BYTES;
  });
}

// ---------------------------------------------------------------------------
// Method implementations
// ---------------------------------------------------------------------------

async function tryDeviceLogin(
  input: ConnectTransferInput,
  deps: ConnectDeps,
): Promise<{ outcome: 'ok' | 'unavailable' | 'failed'; reason?: string; operatorCommand?: string; delivery?: 'executed' | 'operator-command' }> {
  const service = getConnectService(input.service)!;
  if (!service.deviceLogin) return { outcome: 'unavailable', reason: 'service has no vendor login command' };
  const argv = service.deviceLogin;
  if (!isLocalNode(input.node, deps.hostname())) {
    // The login must run on the target node itself; hand the operator the
    // exact command rather than pretend it ran here.
    return {
      outcome: 'ok',
      delivery: 'operator-command',
      reason: `run on ${input.node}: ${argv.join(' ')}`,
      operatorCommand: argv.join(' '),
    };
  }
  const status = deps.runInteractive(argv);
  return status === 0
    ? { outcome: 'ok', delivery: 'executed' }
    : { outcome: 'failed', reason: `vendor login exited ${status}` };
}

async function tryScopedToken(
  input: ConnectTransferInput,
  deps: ConnectDeps,
): Promise<{ outcome: 'ok' | 'unavailable' | 'failed'; reason?: string; secretName?: string }> {
  const service = getConnectService(input.service)!;
  if (!service.tokenMint) return { outcome: 'unavailable', reason: 'service cannot mint a token here' };
  const minted = deps.run(service.tokenMint, { timeoutMs: 15_000 });
  const token = minted.status === 0 && minted.error === undefined ? minted.stdout.trim() : '';
  if (token === '' || token.length > 4096 || /\s/.test(token)) {
    return { outcome: 'failed', reason: 'vendor did not return a scoped token' };
  }
  const secretName = connectSecretName(input.service, input.node);
  const stored = deps.storeSecret(secretName, token);
  if (!stored.ok) {
    return { outcome: 'failed', reason: `secret store refused: ${stored.reason ?? 'unavailable'}` };
  }
  return { outcome: 'ok', secretName };
}

interface SealedFile {
  path: string;
  mode: number;
  data: string;
}

/**
 * Seal approved session files into an AES-256-GCM bundle on disk; vault the
 * data key in Phantom Secrets. File contents are read here and only here,
 * straight into the sealed envelope; they are never printed, logged or
 * returned.
 */
function sealSessionBundle(
  input: ConnectTransferInput,
  files: CollectedSessionFile[],
  grantId: string,
  deps: ConnectDeps,
): { ok: true; bundleFile: string; secretName: string } | { ok: false; reason: string } {
  const plain: { v: 1; service: string; node: string; createdAt: string; files: SealedFile[] } = {
    v: 1,
    service: input.service,
    node: input.node,
    createdAt: deps.now().toISOString(),
    files: [],
  };
  for (const f of files) {
    // Defensive re-check right before the read: the exclusion gate runs on
    // every path, every time, no matter how it reached this list.
    if (isExcludedSessionPath(f.rel)) {
      return { ok: false, reason: `refused: ${f.rel} is excluded session content` };
    }
    let data: Buffer;
    try {
      data = readFileSync(f.absolute);
    } catch {
      return { ok: false, reason: `could not read ~/${f.rel}` };
    }
    plain.files.push({ path: f.rel, mode: f.mode, data: data.toString('base64') });
  }
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const secretName = connectBundleKeyName(grantId);
  const stored = deps.storeSecret(secretName, key.toString('base64'));
  if (!stored.ok) {
    return { ok: false, reason: `bundle key could not be vaulted: ${stored.reason ?? 'secret store unavailable'}` };
  }
  const bundleFile = `${grantId}.bundle.json`;
  try {
    ensureConnectDirectory('bundles');
    writePrivateFileAtomic(
      join(connectBundlesDir(), bundleFile),
      JSON.stringify({
        v: 1,
        alg: 'aes-256-gcm',
        service: input.service,
        node: input.node,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: sealed.toString('base64'),
      }, null, 2) + '\n',
    );
  } catch (err) {
    return { ok: false, reason: `bundle could not be written: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, bundleFile, secretName };
}

async function trySessionCopy(
  input: ConnectTransferInput,
  deps: ConnectDeps,
  grantId: string,
): Promise<{
  outcome: 'ok' | 'unavailable' | 'refused' | 'failed';
  reason?: string;
  bundleFile?: string;
  secretName?: string;
  sessionPaths?: string[];
}> {
  const service = getConnectService(input.service)!;
  if (service.sessionCopyProhibitedReason !== null) {
    return { outcome: 'refused', reason: service.sessionCopyProhibitedReason };
  }
  const candidates = listSessionFiles(input.service, homedir());
  if (candidates.length === 0) {
    return { outcome: 'unavailable', reason: 'no session files present' };
  }
  if (typeof input.confirmSessionFile !== 'function') {
    // Per-item approval is mandatory; without an approver the method cannot run.
    return { outcome: 'refused', reason: 'session-file copy needs an explicit approval per file' };
  }
  const approved: CollectedSessionFile[] = [];
  for (const f of candidates) {
    const refusal = sessionCopyRefusal(input.service, f.rel);
    if (refusal !== null) {
      return { outcome: 'refused', reason: refusal };
    }
    if (await input.confirmSessionFile(f.rel)) {
      approved.push(f);
    }
  }
  if (approved.length === 0) {
    return { outcome: 'refused', reason: 'no session file was approved' };
  }
  const sealed = sealSessionBundle(input, approved, grantId, deps);
  if (!sealed.ok) {
    return { outcome: 'failed', reason: sealed.reason };
  }
  return {
    outcome: 'ok',
    bundleFile: sealed.bundleFile,
    secretName: sealed.secretName,
    sessionPaths: approved.map((f) => f.rel),
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Execute the approved transfer. The caller (CLI) has already collected the
 * human approval for the grant itself; this engine only picks and runs the
 * first applicable method in strict order.
 */
export async function executeConnectTransfer(
  input: ConnectTransferInput,
  deps: ConnectDeps,
): Promise<ConnectTransferResult> {
  const service = getConnectService(input.service);
  if (!service) {
    return { ok: false, reason: `unknown service "${input.service}"`, attempts: [] };
  }
  const methods: readonly ConnectTransferMethod[] = input.requestedMethod
    ? [input.requestedMethod]
    : CONNECT_METHOD_ORDER;

  const grantId = newGrantId();
  const attempts: ConnectAttempt[] = [];

  for (const method of methods) {
    if (method === 'device-login') {
      const r = await tryDeviceLogin(input, deps);
      attempts.push({ method, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
      if (r.outcome === 'ok') {
        const grant: ConnectGrant = {
          schemaVersion: 1,
          id: grantId,
          service: input.service,
          node: input.node,
          account: input.account,
          scopes: [...input.scopes],
          method,
          delivery: r.delivery ?? 'executed',
          secretName: null,
          bundleFile: null,
          sessionPaths: [],
          attempts,
          requestId: input.requestId ?? null,
          createdAt: deps.now().toISOString(),
          revokedAt: null,
          revokedReason: null,
        };
        return { ok: true, grant, attempts, ...(r.operatorCommand ? { operatorCommand: r.operatorCommand } : {}) };
      }
      continue;
    }
    if (method === 'scoped-token') {
      const r = await tryScopedToken(input, deps);
      attempts.push({ method, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
      if (r.outcome === 'ok') {
        const grant: ConnectGrant = {
          schemaVersion: 1,
          id: grantId,
          service: input.service,
          node: input.node,
          account: input.account,
          scopes: [...input.scopes],
          method,
          delivery: 'vaulted',
          secretName: r.secretName ?? null,
          bundleFile: null,
          sessionPaths: [],
          attempts,
          requestId: input.requestId ?? null,
          createdAt: deps.now().toISOString(),
          revokedAt: null,
          revokedReason: null,
        };
        return { ok: true, grant, attempts };
      }
      continue;
    }
    // session-copy
    const r = await trySessionCopy(input, deps, grantId);
    attempts.push({ method, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
    if (r.outcome === 'ok') {
      const grant: ConnectGrant = {
        schemaVersion: 1,
        id: grantId,
        service: input.service,
        node: input.node,
        account: input.account,
        scopes: [...input.scopes],
        method,
        delivery: 'sealed-bundle',
        secretName: r.secretName ?? null,
        bundleFile: r.bundleFile ?? null,
        sessionPaths: r.sessionPaths ?? [],
        attempts,
        requestId: input.requestId ?? null,
        createdAt: deps.now().toISOString(),
        revokedAt: null,
        revokedReason: null,
      };
      return { ok: true, grant, attempts };
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    reason: last?.reason ?? 'no transfer method was available',
    attempts,
  };
}

// ---------------------------------------------------------------------------
// Bundle maintenance (revocation cleanup)
// ---------------------------------------------------------------------------

/** Remove a sealed bundle file by basename (refuses path escapes). */
export function removeSealedBundle(bundleFile: string): boolean {
  try {
    if (basename(bundleFile) !== bundleFile || bundleFile.includes(sep)) return false;
    const path = join(connectBundlesDir(), bundleFile);
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
