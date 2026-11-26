/** Stable, private VAPID identity for an explicitly started phone gateway. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import { isPublicHttpsOrigin } from './remote-access.js';
import { assertPrivatePath, lstatOrNull, readPrivateJsonFile, withPrivateFileLock } from './remote-fs.js';
import type { RemotePushConfig } from './remote-push.js';

const FILE = 'remote-push-vapid.json';
const MAX_BYTES = 2_048;
const ENCODED = /^[A-Za-z0-9_-]+$/;
interface Stored extends RemotePushConfig { v: 1 }

function validKey(value: unknown, length: number): value is string {
  return typeof value === 'string' && ENCODED.test(value) && Buffer.from(value, 'base64url').length === length;
}

function read(path: string, subject: string): RemotePushConfig {
  const parsed = readPrivateJsonFile(path, MAX_BYTES, 'Remote push VAPID file', 'Remote push VAPID path is not private');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Remote push VAPID file is invalid');
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1 || row.subject !== subject || Object.keys(row).length !== 4
    || !validKey(row.publicKey, 65) || !validKey(row.privateKey, 32)) {
    throw new Error('Remote push VAPID file is invalid or belongs to another origin');
  }
  return { publicKey: row.publicKey, privateKey: row.privateKey, subject };
}

/**
 * Called only after explicit --remote-config startup. A missing file gets one
 * identity, atomically; a malformed or mismatched file fails closed and is
 * never silently rotated (existing browser subscriptions depend on this key).
 */
export function loadOrCreateRemoteVapid(subject: string, root = defaultVerseRoot()): RemotePushConfig {
  if (!isPublicHttpsOrigin(subject)) throw new Error('Remote push VAPID subject must be a public HTTPS origin');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivatePath(root, 'directory', 'Remote push VAPID path is not private');
  const path = join(root, FILE);
  if (lstatOrNull(path)) return read(path, subject);
  return withPrivateFileLock(root, `${path}.lock`, 'Remote push VAPID path is not private', 'Remote push VAPID lock is not private', () => {
    if (lstatOrNull(path)) return read(path, subject);
    const keys = webpush.generateVAPIDKeys();
    const value: Stored = { v: 1, publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
    if (!validKey(value.publicKey, 65) || !validKey(value.privateKey, 32)) throw new Error('Remote push VAPID generation failed');
    writePrivateFileAtomically(root, path, `${JSON.stringify(value)}\n`);
    return read(path, subject);
  });
}
