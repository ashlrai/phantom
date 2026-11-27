/** Stable, private VAPID identity for an explicitly started phone gateway. */
import { join } from 'node:path';
import webpush from 'web-push';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import {
  ensurePrivateDirectory, isBase64UrlOfByteLength, isPublicHttpsOrigin,
  lstatOrNull, readPrivateJsonObject, withExclusivePrivateLock,
} from './remote-access.js';
import type { RemotePushConfig } from './remote-push.js';

const FILE = 'remote-push-vapid.json';
const MAX_BYTES = 2_048;
interface Stored extends RemotePushConfig { v: 1 }

function read(path: string, subject: string): RemotePushConfig {
  const row = readPrivateJsonObject(path, MAX_BYTES, 'Remote push VAPID file', 'Remote push VAPID path is not private');
  if (row.v !== 1 || row.subject !== subject || Object.keys(row).length !== 4
    || !isBase64UrlOfByteLength(row.publicKey, 65) || !isBase64UrlOfByteLength(row.privateKey, 32)) {
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
  ensurePrivateDirectory(root, 'Remote push VAPID path is not private');
  const path = join(root, FILE);
  if (lstatOrNull(path)) return read(path, subject);
  return withExclusivePrivateLock(
    root,
    `${path}.lock`,
    { dir: 'Remote push VAPID path is not private', lock: 'Remote push VAPID lock is not private' },
    () => {
      if (lstatOrNull(path)) return read(path, subject);
      const keys = webpush.generateVAPIDKeys();
      const value: Stored = { v: 1, publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
      if (!isBase64UrlOfByteLength(value.publicKey, 65) || !isBase64UrlOfByteLength(value.privateKey, 32)) {
        throw new Error('Remote push VAPID generation failed');
      }
      writePrivateFileAtomically(root, path, `${JSON.stringify(value)}\n`);
      return read(path, subject);
    },
  );
}
