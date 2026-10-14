/** Browser-safe saved metadata projection. No native protocol, ownership or control evidence. */
import type { VerseEngine } from './types.js';

export interface VerseNativeSessionBinding {
  schemaVersion: 1;
  scope: 'native-session-binding';
  source: 'phantom-session-metadata';
  sessionId: string;
  engine: VerseEngine;
  seatId: string;
  nativeSessionId: string | null;
  nativeIdState: 'recorded' | 'not-created' | 'unsupported' | 'invalid';
  savedStatus: 'idle' | 'running' | 'error';
  savedUpdatedAt: string;
  liveOwnerState: 'unverified';
  desktopAttachment: 'unverified';
  controlEnabled: false;
}
const KEYS = ['schemaVersion', 'scope', 'source', 'sessionId', 'engine', 'seatId', 'nativeSessionId', 'nativeIdState',
  'savedStatus', 'savedUpdatedAt', 'liveOwnerState', 'desktopAttachment', 'controlEnabled'];
export function validNativeBindingId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
export function validNativeBindingSeatId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
}
export function validNativeBindingSavedDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
/** Refuse extra fields, accessors and contradictory projection claims before displaying metadata. */
export function validVerseNativeSessionBinding(value: unknown): value is VerseNativeSessionBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== KEYS.length || keys.some(key => typeof key !== 'string' || !KEYS.includes(key) ||
    !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.scope !== 'native-session-binding' || row.source !== 'phantom-session-metadata' ||
    !validNativeBindingId(row.sessionId) || !validNativeBindingSeatId(row.seatId) ||
    (typeof row.engine !== 'string' || !['claude', 'codex', 'grok', 'local', 'devin'].includes(row.engine)) ||
    (typeof row.savedStatus !== 'string' || !['idle', 'running', 'error'].includes(row.savedStatus)) || !validNativeBindingSavedDate(row.savedUpdatedAt) ||
    row.liveOwnerState !== 'unverified' || row.desktopAttachment !== 'unverified' || row.controlEnabled !== false) return false;
  if (row.engine !== 'claude' && row.engine !== 'codex') return row.nativeIdState === 'unsupported' && row.nativeSessionId === null;
  return row.nativeIdState === 'recorded' ? validNativeBindingId(row.nativeSessionId)
    : (row.nativeIdState === 'not-created' || row.nativeIdState === 'invalid') && row.nativeSessionId === null;
}
