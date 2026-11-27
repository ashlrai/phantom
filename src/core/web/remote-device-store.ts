/**
 * Private, durable registry for paired browser credentials. No bearer token or
 * authentication challenge is persisted here. Each read reloads the file so a
 * revocation in another store instance is visible before the next operation.
 */
import { join } from 'node:path';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import { assertPrivatePath, lstatOrNull, readPrivateJsonFile, withPrivateFileLock } from './remote-fs.js';

export interface RemoteDevice {
  id: string;
  label: string;
  subject: string;
  email: string;
  scopes: { read: true; act: boolean };
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface Registry { v: 1; devices: RemoteDevice[] }
const FILE = 'remote-devices.json';
const MAX_BYTES = 1_048_576;
const ENCODED = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function validDevice(value: unknown): value is RemoteDevice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  const scopes = d.scopes as Record<string, unknown> | undefined;
  return typeof d.id === 'string' && /^[a-f0-9-]{36}$/.test(d.id)
    && typeof d.label === 'string' && d.label.length > 0 && d.label.length <= 80
    && typeof d.subject === 'string' && d.subject.length > 0 && d.subject.length <= 256
    && typeof d.email === 'string' && d.email.length > 0 && d.email.length <= 320
    && scopes?.read === true && typeof scopes.act === 'boolean'
    && typeof d.credentialId === 'string' && d.credentialId.length >= 16 && d.credentialId.length <= 1024 && ENCODED.test(d.credentialId)
    && typeof d.publicKey === 'string' && d.publicKey.length >= 16 && d.publicKey.length <= 8192 && ENCODED.test(d.publicKey)
    && Number.isSafeInteger(d.counter) && (d.counter as number) >= 0
    && Array.isArray(d.transports) && d.transports.every((t: unknown) => typeof t === 'string' && TRANSPORTS.has(t))
    && (d.deviceType === 'singleDevice' || d.deviceType === 'multiDevice') && typeof d.backedUp === 'boolean'
    && Number.isSafeInteger(d.createdAt) && (d.createdAt as number) > 0
    && (d.lastUsedAt === null || Number.isSafeInteger(d.lastUsedAt))
    && (d.revokedAt === null || Number.isSafeInteger(d.revokedAt));
}

function clone(device: RemoteDevice): RemoteDevice {
  return { ...device, scopes: { ...device.scopes }, transports: [...device.transports] };
}

/**
 * The write lock is create-exclusive and never silently stolen. A crash can
 * leave it behind; an operator must inspect/remove it before writes resume.
 * This favors a denied pairing over losing a concurrent revocation.
 */
export function createRemoteDeviceStore(root = defaultVerseRoot()) {
  const path = join(root, FILE);
  const lockPath = `${path}.lock`;
  const revokeListeners = new Set<(id: string) => void>();
  function read(): Registry {
    if (!lstatOrNull(root)) return { v: 1, devices: [] };
    assertPrivatePath(root, 'directory', 'Remote device registry is not private');
    if (!lstatOrNull(path)) return { v: 1, devices: [] };
    const data = readPrivateJsonFile(path, MAX_BYTES, 'Remote device registry');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Remote device registry is invalid');
    const registry = data as Record<string, unknown>;
    if (registry.v !== 1 || !Array.isArray(registry.devices) || registry.devices.length > 256
      || !registry.devices.every(validDevice)) throw new Error('Remote device registry is invalid');
    const devices = registry.devices as RemoteDevice[];
    if (new Set(devices.map((d) => d.id)).size !== devices.length
      || new Set(devices.map((d) => d.credentialId)).size !== devices.length) throw new Error('Remote device registry has duplicate credentials');
    return { v: 1, devices };
  }
  function mutate<T>(update: (registry: Registry) => T): T {
    return withPrivateFileLock(root, lockPath, 'Remote device registry is not private', 'Remote device registry lock is not private', () => {
      const registry = read();
      const result = update(registry);
      const bytes = `${JSON.stringify(registry)}\n`;
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Remote device registry is too large');
      writePrivateFileAtomically(root, path, bytes);
      return result;
    });
  }
  return {
    list(): RemoteDevice[] { return read().devices.map(clone); },
    getActive(id: string, subject: string): RemoteDevice | null {
      const found = read().devices.find((d) => d.id === id && d.subject === subject && d.revokedAt === null);
      return found ? clone(found) : null;
    },
    add(device: RemoteDevice): void {
      if (!validDevice(device) || device.revokedAt !== null) throw new Error('Invalid remote device');
      mutate((registry) => {
        if (registry.devices.some((d) => d.id === device.id || d.credentialId === device.credentialId)) throw new Error('Remote credential already paired');
        registry.devices.push(clone(device));
      });
    },
    revoke(id: string, at: number): boolean {
      if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Invalid revocation time');
      const changed = mutate((registry) => {
        const device = registry.devices.find((d) => d.id === id && d.revokedAt === null);
        if (!device) return false;
        device.revokedAt = at;
        return true;
      });
      if (changed) for (const listener of revokeListeners) {
        try { listener(id); } catch { /* a stream listener cannot undo revocation */ }
      }
      return changed;
    },
    onRevoked(listener: (id: string) => void): () => void {
      revokeListeners.add(listener);
      return () => { revokeListeners.delete(listener); };
    },
    updateCounter(id: string, subject: string, credentialId: string, counter: number, at: number): boolean {
      if (!Number.isSafeInteger(counter) || counter < 0 || !Number.isSafeInteger(at) || at <= 0) return false;
      return mutate((registry) => {
        const device = registry.devices.find((d) => d.id === id && d.subject === subject
          && d.credentialId === credentialId && d.revokedAt === null);
        if (!device || (device.counter > 0 && counter <= device.counter)) return false;
        device.counter = counter;
        device.lastUsedAt = at;
        return true;
      });
    },
  };
}

export type RemoteDeviceStore = ReturnType<typeof createRemoteDeviceStore>;
