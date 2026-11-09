/**
 * Phone session custody. The cookie value stays in this process.
 * The durable file stores only a Phantom Secrets handle (`phm_phone_session_…`).
 * A restart drops the in-memory cookie, which is the same lifetime as the
 * gateway's other session tickets.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import { defaultVerseRoot } from '../verse/preferences.js';

export const PHONE_SESSION_HANDLE = /^phm_phone_session_[a-f0-9]{32}$/;
const FILE = 'phone-session-handles.json';
const MAX_BYTES = 65_536;

export interface PhoneSessionRecord {
  handle: string;
  deviceId: string;
  subject: string;
  scope: 'read' | 'act';
  expiresAt: number;
}

interface Stored { v: 1; sessions: PhoneSessionRecord[] }

function validRecord(value: unknown): value is PhoneSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['handle', 'deviceId', 'subject', 'scope', 'expiresAt'].includes(key))) return false;
  return typeof record.handle === 'string' && PHONE_SESSION_HANDLE.test(record.handle)
    && typeof record.deviceId === 'string' && /^[a-f0-9-]{36}$/.test(record.deviceId)
    && typeof record.subject === 'string' && record.subject.length > 0 && record.subject.length <= 256
    && (record.scope === 'read' || record.scope === 'act')
    && Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > 0;
}

export function createPhoneSessionCustody(root = defaultVerseRoot(), now: () => number = Date.now) {
  const path = join(root, FILE);
  const tokens = new Map<string, string>();

  function read(): PhoneSessionRecord[] {
    let stat: ReturnType<typeof lstatSync> | null = null;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) {
      throw new Error('Phone session handle file is not private');
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Phone session handle file is invalid');
    const body = parsed as Record<string, unknown>;
    if (body.v !== 1 || !Array.isArray(body.sessions) || body.sessions.length > 256 || !body.sessions.every(validRecord)) {
      throw new Error('Phone session handle file is invalid');
    }
    return (body.sessions as PhoneSessionRecord[]).map((record) => ({ ...record }));
  }

  function write(sessions: PhoneSessionRecord[]): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const body: Stored = { v: 1, sessions };
    const text = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Phone session handle file is too large');
    writePrivateFileAtomically(root, path, text);
  }

  function live(): PhoneSessionRecord[] {
    const at = now();
    return read().filter((record) => record.expiresAt > at);
  }

  return {
    path,
    issue(input: { deviceId: string; subject: string; scope: 'read' | 'act'; expiresAt: number; token: string }): PhoneSessionRecord {
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new Error('Invalid phone session token');
      const record: PhoneSessionRecord = {
        handle: `phm_phone_session_${randomBytes(16).toString('hex')}`,
        deviceId: input.deviceId,
        subject: input.subject,
        scope: input.scope,
        expiresAt: input.expiresAt,
      };
      if (!validRecord(record)) throw new Error('Invalid phone session record');
      const sessions = live().filter((item) => item.deviceId !== input.deviceId || item.subject !== input.subject);
      for (const previous of live()) {
        if (previous.deviceId === input.deviceId && previous.subject === input.subject) tokens.delete(previous.handle);
      }
      sessions.push(record);
      write(sessions);
      tokens.set(record.handle, input.token);
      return record;
    },
    drop(handle: string): void {
      tokens.delete(handle);
      write(read().filter((record) => record.handle !== handle));
    },
    list(): PhoneSessionRecord[] {
      return live();
    },
    /** Null when the handle is unknown, expired, or this process did not issue it. */
    tokenFor(handle: string): string | null {
      const record = live().find((item) => item.handle === handle);
      if (!record) {
        tokens.delete(handle);
        return null;
      }
      return tokens.get(handle) ?? null;
    },
  };
}

export type PhoneSessionCustody = ReturnType<typeof createPhoneSessionCustody>;
