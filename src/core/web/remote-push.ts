/**
 * Per-credential Web Push sender with bounded, scrubbed fleet summaries.
 */
import { join } from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import {
  REMOTE_SUBJECT_RE, REMOTE_UUID_RE, assertPrivatePath, isBase64UrlOfByteLength, isPublicHttpsOrigin,
  isRemoteRecord, lstatOrNull, readPrivateJsonObject, withExclusivePrivateLock,
} from './remote-access.js';
import { sanitizePushDetail } from './remote-push-fleet.js';
import type { RemoteDeviceStore } from './remote-device-store.js';

const FILE = 'remote-push.json';
const MAX_FILE_BYTES = 262_144;
const COALESCE_MS = 60_000;
const MAX_SUBSCRIPTIONS = 32;
export type RemotePushKind = 'needs-you' | 'completed' | 'fleet-merged' | 'fleet-lane-held' | 'leader-reply';
export interface RemotePushDetail { detail?: string; count?: number }
const PUSH_KINDS: RemotePushKind[] = ['needs-you', 'completed', 'fleet-merged', 'fleet-lane-held', 'leader-reply'];

interface Entry { deviceId: string; subject: string; subscription: PushSubscription; createdAt: number }
interface Registry { v: 1; entries: Entry[] }

export interface RemotePushConfig {
  publicKey: string;
  privateKey: string;
  /** A stable HTTPS or mailto contact for VAPID, never localhost. */
  subject: string;
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 30 || value.length > 2048 || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port
      && url.hostname.endsWith('.push.apple.com') && url.pathname.length > 1;
  } catch { return false; }
}

function validSubscription(value: unknown): value is PushSubscription {
  if (!isRemoteRecord(value)) return false;
  const record = value;
  if (!Object.keys(record).every((key) => ['endpoint', 'expirationTime', 'keys'].includes(key))
    || !validEndpoint(record.endpoint)) return false;
  if (record.expirationTime !== undefined && record.expirationTime !== null
    && (!Number.isSafeInteger(record.expirationTime) || (record.expirationTime as number) <= Date.now())) return false;
  if (!isRemoteRecord(record.keys)) return false;
  const keys = record.keys;
  return Object.keys(keys).length === 2
    && isBase64UrlOfByteLength(keys.p256dh, 65) && isBase64UrlOfByteLength(keys.auth, 16);
}

function validConfig(value: RemotePushConfig): boolean {
  if (!isRemoteRecord(value) || typeof value.subject !== 'string') return false;
  if (!isBase64UrlOfByteLength(value.publicKey, 65) || !isBase64UrlOfByteLength(value.privateKey, 32)) return false;
  if (value.subject.startsWith('mailto:')) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.subject.slice(7));
  return isPublicHttpsOrigin(value.subject);
}

function validEntry(value: unknown): value is Entry {
  if (!isRemoteRecord(value)) return false;
  const entry = value;
  return typeof entry.deviceId === 'string' && REMOTE_UUID_RE.test(entry.deviceId)
    && typeof entry.subject === 'string' && REMOTE_SUBJECT_RE.test(entry.subject)
    && validSubscription(entry.subscription) && Number.isSafeInteger(entry.createdAt)
    && (entry.createdAt as number) > 0;
}

/** The caller mounts HTTP routes only after Access, device-session and CSRF checks. */
export function createRemotePush(config: RemotePushConfig, devices: RemoteDeviceStore,
  options: { root?: string; now?: () => number; send?: typeof webpush.sendNotification } = {}) {
  if (!validConfig(config)) throw new Error('Invalid remote Web Push configuration');
  const root = options.root ?? defaultVerseRoot();
  const path = join(root, FILE);
  const lockPath = `${path}.lock`;
  const now = options.now ?? Date.now;
  const send = options.send ?? webpush.sendNotification;
  const lastSent = new Map<string, number>();
  const offRevoke = devices.onRevoked((id) => { try { removeDevice(id); } catch { /* fail closed at send-time */ } });

  function read(): Registry {
    if (!lstatOrNull(root)) return { v: 1, entries: [] };
    assertPrivatePath(root, 'directory', 'Remote push store is not private');
    if (!lstatOrNull(path)) return { v: 1, entries: [] };
    const registry = readPrivateJsonObject(path, MAX_FILE_BYTES, 'Remote push store');
    if (registry.v !== 1 || !Array.isArray(registry.entries) || registry.entries.length > MAX_SUBSCRIPTIONS
      || !registry.entries.every(validEntry)) throw new Error('Remote push store is invalid');
    const entries = registry.entries as Entry[];
    if (new Set(entries.map((entry) => entry.deviceId)).size !== entries.length) throw new Error('Remote push store has duplicate devices');
    return { v: 1, entries };
  }
  function mutate<T>(update: (registry: Registry) => T): T {
    return withExclusivePrivateLock(
      root,
      lockPath,
      { dir: 'Remote push store is not private', lock: 'Remote push lock is not private' },
      () => {
        const registry = read();
        const result = update(registry);
        const bytes = `${JSON.stringify(registry)}\n`;
        if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw new Error('Remote push store is too large');
        writePrivateFileAtomically(root, path, bytes);
        return result;
      },
    );
  }
  function removeDevice(deviceId: string): void {
    mutate((registry) => { registry.entries = registry.entries.filter((entry) => entry.deviceId !== deviceId); });
    for (const kind of PUSH_KINDS) lastSent.delete(`${deviceId}:${kind}`);
  }
  return {
    publicKey: config.publicKey,
    subscribe(deviceId: string, subject: string, subscription: unknown): boolean {
      if (!devices.getActive(deviceId, subject) || !validSubscription(subscription)) return false;
      const entry: Entry = { deviceId, subject,
        subscription: { endpoint: subscription.endpoint, keys: { ...subscription.keys } }, createdAt: now() };
      mutate((registry) => {
        registry.entries = registry.entries.filter((existing) => existing.deviceId !== deviceId);
        if (registry.entries.length >= MAX_SUBSCRIPTIONS) throw new Error('Remote push subscriptions are full');
        registry.entries.push(entry);
      });
      for (const kind of PUSH_KINDS) lastSent.delete(`${deviceId}:${kind}`);
      return true;
    },
    unsubscribe(deviceId: string, subject: string): boolean {
      if (!devices.getActive(deviceId, subject)) return false;
      removeDevice(deviceId);
      return true;
    },
    async send(kind: RemotePushKind, detail: RemotePushDetail = {}): Promise<{ attempted: number; delivered: number; retired: number }> {
      if (!PUSH_KINDS.includes(kind)) throw new Error('Invalid push kind');
      const payload: { kind: RemotePushKind } & RemotePushDetail = { kind };
      if (kind === 'fleet-merged' || kind === 'fleet-lane-held') {
        if (typeof detail.detail === 'string') payload.detail = sanitizePushDetail(detail.detail);
        if (typeof detail.count === 'number' && Number.isSafeInteger(detail.count) && detail.count > 0) payload.count = detail.count;
      }
      if (kind === 'leader-reply' && Number.isSafeInteger(detail.count) && (detail.count ?? 0) > 0) payload.count = detail.count;
      let attempted = 0;
      let delivered = 0;
      let retired = 0;
      for (const entry of read().entries) {
        if (!devices.getActive(entry.deviceId, entry.subject)) { removeDevice(entry.deviceId); retired++; continue; }
        const last = lastSent.get(`${entry.deviceId}:${kind}`) ?? 0;
        if (now() - last < COALESCE_MS) continue;
        attempted++;
        // Bound delivery attempts as well as successes during a provider outage.
        lastSent.set(`${entry.deviceId}:${kind}`, now());
        try {
          await send(entry.subscription, JSON.stringify(payload), { vapidDetails: config, TTL: 300,
            timeout: 5_000, urgency: kind === 'needs-you' ? 'high' : 'normal', topic: `ashlr-${kind}` });
          delivered++;
        } catch (error) {
          const status = (error as { statusCode?: unknown }).statusCode;
          if (status === 404 || status === 410) { removeDevice(entry.deviceId); retired++; }
        }
      }
      return { attempted, delivered, retired };
    },
    close(): void { offRevoke(); },
  };
}
