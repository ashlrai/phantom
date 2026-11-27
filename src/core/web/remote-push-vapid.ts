/** Stable, private VAPID identity for an explicitly started phone gateway. */
import { join } from 'node:path';
import webpush from 'web-push';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import { isPublicHttpsOrigin } from './remote-access.js';
import type { RemotePushConfig } from './remote-push.js';
import {
  ensurePrivateDirectory, isBase64UrlBytes, lstatOrNull, readPrivateJsonRecord, withPrivateFileLock,
} from './remote-store-helpers.js';

const FILE = 'remote-push-vapid.json';
const MAX_BYTES = 2_048;
interface Stored extends RemotePushConfig { v: 1 }
const VAPID_LABELS = {
  notPrivate: 'Remote push VAPID path is not private',
  tooLarge: 'Remote push VAPID file is too large',
  unreadable: 'Remote push VAPID file is unreadable',
  invalid: 'Remote push VAPID file is invalid',
};

function read(path: string, subject: string): RemotePushConfig {
  const row = readPrivateJsonRecord(path, MAX_BYTES, VAPID_LABELS);
  if (row.v !== 1 || row.subject !== subject || Object.keys(row).length !== 4
    || !isBase64UrlBytes(row.publicKey, 65) || !isBase64UrlBytes(row.privateKey, 32)) {
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
  ensurePrivateDirectory(root, VAPID_LABELS.notPrivate);
  const path = join(root, FILE);
  if (lstatOrNull(path)) return read(path, subject);
  return withPrivateFileLock(root, `${path}.lock`, VAPID_LABELS.notPrivate, 'Remote push VAPID lock is not private', () => {
    if (lstatOrNull(path)) return read(path, subject);
    const keys = webpush.generateVAPIDKeys();
    const value: Stored = { v: 1, publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
    if (!isBase64UrlBytes(value.publicKey, 65) || !isBase64UrlBytes(value.privateKey, 32)) {
      throw new Error('Remote push VAPID generation failed');
    }
    writePrivateFileAtomically(root, path, `${JSON.stringify(value)}\n`);
    return read(path, subject);
  });
}
