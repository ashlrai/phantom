/**
 * core/connect/store.ts: the connect state store.
 *
 * Lives at ~/.ashlr/connect/store.json (mode 0600, dir 0700), resolved per
 * call through ashlrHome() so a relocated HOME/ASHLR_HOME is honored.
 *
 * The store holds ONLY value-free metadata: request and grant records.
 * Secret values never enter it: a vaulted grant records the Phantom Secrets
 * NAME, a session-copy grant records the sealed bundle file name and the
 * relative paths it covers.
 *
 * Reads never throw: a missing, malformed or oversized store loads as empty.
 */

import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import {
  ensurePrivateDirectory,
  readPrivateFileCapped,
  writePrivateFileAtomic,
} from '../verse/preferences.js';
import { isConnectServiceId } from './services.js';
import {
  CONNECT_NODE_ID_RE,
  CONNECT_STORE_SCHEMA_VERSION,
  type ConnectGrant,
  type ConnectRequest,
  type ConnectStore,
} from './types.js';

const CONNECT_DIR = 'connect';
const STORE_FILE = 'store.json';
const BUNDLES_DIR = 'bundles';
const STORE_MAX_BYTES = 512 * 1024;

export function connectHome(): string {
  return join(ashlrHome(), CONNECT_DIR);
}

export function connectStorePath(): string {
  return join(connectHome(), STORE_FILE);
}

export function connectBundlesDir(): string {
  return join(connectHome(), BUNDLES_DIR);
}

export function ensureConnectDirectory(...sub: string[]): string {
  ensurePrivateDirectory(ashlrHome());
  let dir = connectHome();
  ensurePrivateDirectory(dir);
  for (const part of sub) {
    dir = join(dir, part);
    ensurePrivateDirectory(dir);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Validation (value-free; malformed records are dropped, never repaired)
// ---------------------------------------------------------------------------

const METHODS = new Set(['device-login', 'scoped-token', 'session-copy']);
const DELIVERIES = new Set(['executed', 'operator-command', 'vaulted', 'sealed-bundle']);
const REQUEST_STATUSES = new Set(['pending', 'approved', 'denied']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function strOrNull(v: unknown, max = 256): v is string | null {
  return v === null || str(v, max);
}

function scopesOf(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((s) => str(s, 64)) && v.length <= 16 ? [...v] as string[] : null;
}

function isValidRequest(v: unknown): v is ConnectRequest {
  if (!isRecord(v)) return false;
  return (
    v['schemaVersion'] === CONNECT_STORE_SCHEMA_VERSION &&
    str(v['id'], 64) && /^con_req_[a-z0-9]+$/.test(v['id'] as string) &&
    typeof v['service'] === 'string' && isConnectServiceId(v['service']) &&
    typeof v['node'] === 'string' && CONNECT_NODE_ID_RE.test(v['node']) &&
    scopesOf(v['scopes']) !== null &&
    (v['requestedMethod'] === null || METHODS.has(v['requestedMethod'] as string)) &&
    (v['requestedBy'] === 'agent' || v['requestedBy'] === 'operator') &&
    str(v['requestedAt'], 64) &&
    typeof v['status'] === 'string' && REQUEST_STATUSES.has(v['status']) &&
    strOrNull(v['resolvedAt'], 64) &&
    strOrNull(v['grantId'], 64) &&
    strOrNull(v['note'], 512)
  );
}

function isValidAttempt(v: unknown): boolean {
  return isRecord(v) && METHODS.has(v['method'] as string) &&
    ['ok', 'unavailable', 'refused', 'failed'].includes(v['outcome'] as string) &&
    (v['reason'] === undefined || str(v['reason'], 512));
}

function isValidGrant(v: unknown): v is ConnectGrant {
  if (!isRecord(v)) return false;
  return (
    v['schemaVersion'] === CONNECT_STORE_SCHEMA_VERSION &&
    str(v['id'], 64) && /^con_gr_[a-z0-9]+$/.test(v['id'] as string) &&
    typeof v['service'] === 'string' && isConnectServiceId(v['service']) &&
    typeof v['node'] === 'string' && CONNECT_NODE_ID_RE.test(v['node']) &&
    strOrNull(v['account'], 256) &&
    scopesOf(v['scopes']) !== null &&
    typeof v['method'] === 'string' && METHODS.has(v['method']) &&
    typeof v['delivery'] === 'string' && DELIVERIES.has(v['delivery']) &&
    strOrNull(v['secretName'], 128) &&
    strOrNull(v['bundleFile'], 128) &&
    Array.isArray(v['sessionPaths']) && (v['sessionPaths'] as unknown[]).every((p) => str(p, 512)) &&
    Array.isArray(v['attempts']) && (v['attempts'] as unknown[]).every(isValidAttempt) &&
    strOrNull(v['requestId'], 64) &&
    str(v['createdAt'], 64) &&
    strOrNull(v['revokedAt'], 64) &&
    strOrNull(v['revokedReason'], 512)
  );
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export function emptyConnectStore(): ConnectStore {
  return { schemaVersion: CONNECT_STORE_SCHEMA_VERSION, requests: [], grants: [] };
}

export function loadConnectStore(path: string = connectStorePath()): ConnectStore {
  const file = readPrivateFileCapped(path, STORE_MAX_BYTES);
  if (!file || file.truncated) return emptyConnectStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return emptyConnectStore();
  }
  if (!isRecord(parsed) || parsed['schemaVersion'] !== CONNECT_STORE_SCHEMA_VERSION) {
    return emptyConnectStore();
  }
  const requests = Array.isArray(parsed['requests']) ? (parsed['requests'] as unknown[]).filter(isValidRequest) : [];
  const grants = Array.isArray(parsed['grants']) ? (parsed['grants'] as unknown[]).filter(isValidGrant) : [];
  return { schemaVersion: CONNECT_STORE_SCHEMA_VERSION, requests, grants };
}

export function saveConnectStore(store: ConnectStore, path: string = connectStorePath()): void {
  ensureConnectDirectory();
  writePrivateFileAtomic(path, JSON.stringify(store, null, 2) + '\n');
}
