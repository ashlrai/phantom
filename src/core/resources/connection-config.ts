/** Pure roster schema; validation imports no native collector or provider runtime. */
import { isAbsolute } from 'node:path';
import type { ResourceAccountConnection } from './connection-types.js';
import { RESOURCE_POOL_MANIFEST_MAX_BYTES } from './pool-policy.js';

export interface ResourceConnectionConfig {
  schemaVersion: 1;
  intervalMs: number;
  accounts: Array<{ id: string; label: string; provider: ResourceAccountConnection['provider']; command: string[];
    expectedAccountHint?: string }>;
}
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
    [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function text(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= bytes &&
    [...value].every((character) => { const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); });
}
function array(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.every(key => key === 'length' ||
    typeof key === 'string' && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}

/** Account count follows explicit enrollment; collection keeps its two-client bound and reader byte limits. */
export function validateResourceConnectionConfig(value: unknown): ResourceConnectionConfig {
  if (!record(value) || !exact(value, ['schemaVersion', 'intervalMs', 'accounts']) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.intervalMs) || Number(value.intervalMs) < 30_000 || Number(value.intervalMs) > 3_600_000 || !array(value.accounts, Math.floor(RESOURCE_POOL_MANIFEST_MAX_BYTES / 2))) {
    throw new Error('Invalid native connection configuration');
  }
  const ids = new Set<string>();
  const accounts = value.accounts.map((row) => {
    if (!record(row) || !exact(row, ['id', 'label', 'provider', 'command'], ['expectedAccountHint']) ||
      !text(row.id, 64) || !ID.test(row.id) || ids.has(row.id) || !text(row.label, 80) ||
      typeof row.provider !== 'string' || !['codex', 'claude', 'grok'].includes(row.provider) || !array(row.command, 32) ||
      !row.command.every((arg) => text(arg, 4096)) || !isAbsolute(row.command[0] as string) ||
      row.command.reduce((sum: number, arg) => sum + Buffer.byteLength(arg as string), 0) > 16_384 ||
      (row.expectedAccountHint !== undefined && (typeof row.expectedAccountHint !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedAccountHint)))) {
      throw new Error('Invalid native connection account');
    }
    ids.add(row.id);
    return { id: row.id, label: row.label, provider: row.provider as ResourceAccountConnection['provider'], command: [...row.command] as string[],
      ...(row.expectedAccountHint === undefined ? {} : { expectedAccountHint: row.expectedAccountHint as string }) };
  });
  return { schemaVersion: 1, intervalMs: Number(value.intervalMs), accounts };
}
