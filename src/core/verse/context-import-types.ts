/** Browser-safe reference data contract. Imported words never confer authority. */
import { scrubSecrets, redactGenericHomePaths } from '../util/scrub-secrets.js';

export const CONTEXT_IMPORT_PATH = '/api/verse/context-imports';
export const CONTEXT_IMPORT_FILE_BYTES = 8 * 1024 * 1024;
export const CONTEXT_IMPORT_PASTE_BYTES = 256 * 1024;
export const CONTEXT_IMPORT_ITEM_BYTES = 4 * 1024;
export const CONTEXT_IMPORT_SELECTED_BYTES = 128 * 1024;
export const CONTEXT_IMPORT_BODY_BYTES = 512 * 1024 + 8 * 1024;
export const CONTEXT_IMPORT_MAX_PREVIEW = 512;
export const CONTEXT_IMPORT_MAX_SELECTED = 64;
export const CONTEXT_IMPORT_TRUST = 'untrusted-external-data' as const;
export type ContextImportProvider = 'chatgpt' | 'claude' | 'grok' | 'other';
export type ContextImportProvenance = 'user-paste' | 'user-selected-file';
export const CONTEXT_IMPORT_TRANSFORMATIONS = ['line-endings-normalized', 'credentials-redacted', 'private-home-paths-redacted', 'text-split', 'operator-edited'] as const;
export type ContextImportTransformation = typeof CONTEXT_IMPORT_TRANSFORMATIONS[number];
export interface ContextImportItem {
  id: string; title: string; text: string; sourceLocator: string;
  sourceRole: 'user' | 'assistant' | 'system' | 'tool' | null;
  sourceDate: string | null;
}
export interface ContextImportPreview {
  schemaVersion: 1; format: 'text' | 'phantom-context-capsule-v1' | 'generic-json-text';
  claimedProvider: ContextImportProvider; provenance: ContextImportProvenance;
  sourceLabel: string; sourceDigest: string; items: ContextImportItem[];
  transformations: ContextImportTransformation[]; sanitized: boolean; complete: false; trust: typeof CONTEXT_IMPORT_TRUST; authority: false; autoInject: false;
}
export interface ContextImportDescriptor {
  schemaVersion: 1; projectDigest: string; trust: typeof CONTEXT_IMPORT_TRUST; authority: false; autoInject: false;
}
export interface ContextImportCommitRequest {
  schemaVersion: 1; projectPath: string; projectDigest: string;
  claimedProvider: ContextImportProvider; provenance: ContextImportProvenance;
  sourceLabel: string; sourceDigest: string; selectionDigest: string; items: ContextImportItem[];
  transformations: ContextImportTransformation[];
}
export interface ContextImportRecord extends Omit<ContextImportCommitRequest, 'projectPath'> {
  id: string; importedAt: string; trust: typeof CONTEXT_IMPORT_TRUST; authority: false; autoInject: false;
}
export interface ContextImportCommitResponse { schemaVersion: 1; disposition: 'recorded' | 'replayed'; record: ContextImportRecord }

export const contextImportBytes = (text: string): number => new TextEncoder().encode(text).length;
export function contextImportObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
export function validContextImportProvider(value: unknown): value is ContextImportProvider {
  return typeof value === 'string' && ['chatgpt', 'claude', 'grok', 'other'].includes(value);
}
export function validContextImportDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256_[a-f0-9]{64}$/.test(value);
}
export function validContextImportId(value: unknown): value is string {
  return typeof value === 'string' && /^ctx_[a-f0-9]{64}$/.test(value);
}
export function validContextImportDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
function safeText(value: unknown, max: number, empty = false): value is string {
  // JSON, argv and displayed reference content must agree on the same bytes.
  return typeof value === 'string' && (empty || value.trim().length > 0) && contextImportBytes(value) <= max &&
    !UNSAFE_CONTROLS.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) &&
    scrubSecrets(value) === value && redactGenericHomePaths(value) === value;
}
export function validContextImportLabel(value: unknown): value is string {
  return safeText(value, 160) && !/[/\\\n\t]/.test(value);
}
export function validContextImportItem(value: unknown): value is ContextImportItem {
  if (!contextImportObject(value, ['id', 'title', 'text', 'sourceLocator', 'sourceRole', 'sourceDate'])) return false;
  return typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.id) && scrubSecrets(value.id) === value.id &&
    validContextImportLabel(value.title) && safeText(value.text, CONTEXT_IMPORT_ITEM_BYTES) && safeText(value.sourceLocator, 256) &&
    (value.sourceRole === null || ['user', 'assistant', 'system', 'tool'].includes(value.sourceRole as string)) &&
    (value.sourceDate === null || validContextImportDate(value.sourceDate));
}
export function validContextImportItems(value: unknown, max = CONTEXT_IMPORT_MAX_SELECTED): value is ContextImportItem[] {
  return denseArray(value, max) && value.length > 0 && value.every(validContextImportItem) &&
    new Set(value.map(item => item.id)).size === value.length &&
    (max > CONTEXT_IMPORT_MAX_SELECTED || value.reduce((sum, item) => sum + contextImportBytes(item.text), 0) <= CONTEXT_IMPORT_SELECTED_BYTES);
}
export function validContextImportTransformations(value: unknown): value is ContextImportTransformation[] {
  return denseArray(value, CONTEXT_IMPORT_TRANSFORMATIONS.length) && new Set(value).size === value.length &&
    value.every(item => (CONTEXT_IMPORT_TRANSFORMATIONS as readonly unknown[]).includes(item));
}
function denseArray(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
const PAYLOAD_KEYS = ['schemaVersion', 'projectDigest', 'claimedProvider', 'provenance', 'sourceLabel', 'sourceDigest', 'selectionDigest', 'items', 'transformations'];
function payload(value: Record<string, unknown>): boolean {
  return value.schemaVersion === 1 && validContextImportDigest(value.projectDigest) && validContextImportProvider(value.claimedProvider) &&
    ['user-paste', 'user-selected-file'].includes(value.provenance as string) && validContextImportLabel(value.sourceLabel) &&
    validContextImportDigest(value.sourceDigest) && validContextImportDigest(value.selectionDigest) && validContextImportItems(value.items) &&
    validContextImportTransformations(value.transformations);
}
export function validContextImportCommitRequest(value: unknown): value is ContextImportCommitRequest {
  return contextImportObject(value, [...PAYLOAD_KEYS, 'projectPath']) && payload(value) &&
    typeof value.projectPath === 'string' && value.projectPath.length > 0 && value.projectPath.length <= 4096 && !value.projectPath.includes('\0');
}
export function validContextImportDescriptor(value: unknown): value is ContextImportDescriptor {
  return contextImportObject(value, ['schemaVersion', 'projectDigest', 'trust', 'authority', 'autoInject']) &&
    value.schemaVersion === 1 && validContextImportDigest(value.projectDigest) && value.trust === CONTEXT_IMPORT_TRUST && value.authority === false && value.autoInject === false;
}
export function validContextImportRecord(value: unknown): value is ContextImportRecord {
  return contextImportObject(value, [...PAYLOAD_KEYS, 'id', 'importedAt', 'trust', 'authority', 'autoInject']) && payload(value) &&
    validContextImportId(value.id) && validContextImportDate(value.importedAt) && value.trust === CONTEXT_IMPORT_TRUST && value.authority === false && value.autoInject === false;
}
export function validContextImportCommitResponse(value: unknown): value is ContextImportCommitResponse {
  return contextImportObject(value, ['schemaVersion', 'disposition', 'record']) && value.schemaVersion === 1 &&
    ['recorded', 'replayed'].includes(value.disposition as string) && validContextImportRecord(value.record);
}

/** Canonical serialization of already validated bounded plain values, not a general object serializer. */
export function contextImportCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(contextImportCanonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + contextImportCanonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
