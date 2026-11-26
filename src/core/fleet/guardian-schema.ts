/**
 * Shared schema, validation, hashing and private file I/O for the guardian
 * post-merge verification family (manifest feeds, verification loop, retry
 * preparation/selection and state compaction).
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { DetachedPostMergeRunnerInput } from './detached-post-merge-runner.js';

export type GuardianTerminal = 'pass' | 'fail' | 'unknown';

export interface GuardianStateEntry {
  key: string;
  repo: string;
  sha: string;
  terminal: GuardianTerminal;
  checkedAt: string;
  reason: string;
  failureCategory: string | null;
  cleanup: string;
}

export interface GuardianState {
  version: 1;
  entries: GuardianStateEntry[];
}

const MANIFEST_MAX_BYTES = 1_048_576; // 100 entries x ~6 KB worst-case manifest row
const STATE_MAX_BYTES = 8_388_608; // 1000 entries x ~4.5 KB worst-case state row
const REQUIRED_FIELDS = ['repo', 'cohortId', 'proposalId', 'baseBranch', 'baseHead', 'candidateHead', 'mergeCommit'] as const;
const OPTIONAL_FIELDS = ['runId', 'trajectoryId', 'workItemId'] as const;
const ALL_FIELDS: readonly (typeof REQUIRED_FIELDS[number] | typeof OPTIONAL_FIELDS[number])[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

export const GUARDIAN_MANIFEST_MAX_ENTRIES = 100;
export const GUARDIAN_STATE_MAX_ENTRIES = 1_000;
export const GUARDIAN_MAX_PATH_LENGTH = 4_096;
export const GUARDIAN_SHA_RE = /^[a-f0-9]{40}$/;
export const GUARDIAN_REASONS: ReadonlySet<string> = new Set([
  'verified', 'code-failure', 'verification-infrastructure', 'verification-timeout',
  'invalid-input', 'source-unavailable', 'binding-mismatch', 'worktree-create-failed',
  'manifest-unavailable', 'isolation-lost', 'cleanup-failed', 'record-rejected',
]);
export const GUARDIAN_FAILURE_CATEGORIES: ReadonlySet<string> = new Set(['code', 'infra', 'timeout', 'cancelled']);
export const GUARDIAN_CLEANUPS: ReadonlySet<string> = new Set(['removed', 'failed', 'not-created']);

/** Reject C0 controls (0x00..0x1f) and DEL (0x7f) without a control-char regex. */
export function hasNoControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isSafeText(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && hasNoControlChars(value);
}

/** Replace C0 controls and DEL with '-', cap at 256 UTF-16 code units, fallback to '-'. */
export function sanitizeGuardianText(value: string): string {
  let cleaned = '';
  const limit = Math.min(value.length, 256);
  for (let i = 0; i < limit; i++) {
    const code = value.charCodeAt(i);
    cleaned += code <= 0x1f || code === 0x7f ? '-' : value[i]!;
  }
  return cleaned.length > 0 ? cleaned : '-';
}

export function isValidGuardianRepoPath(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= GUARDIAN_MAX_PATH_LENGTH
    && isAbsolute(value) && hasNoControlChars(value);
}

export function isValidGuardianBranch(value: unknown): value is string {
  return typeof value === 'string' && isSafeText(value) && !value.startsWith('-') && !/\s/.test(value);
}

function validateManifestInput(value: unknown): DetachedPostMergeRunnerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest entry');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !(ALL_FIELDS as readonly string[]).includes(k))) throw new Error('unexpected manifest field');
  for (const k of ALL_FIELDS) {
    const v = obj[k];
    if (v === undefined && (OPTIONAL_FIELDS as readonly string[]).includes(k)) continue;
    if (typeof v !== 'string' || !(k === 'repo' ? isValidGuardianRepoPath(v) : isSafeText(v))) {
      throw new Error(`invalid manifest ${k}`);
    }
  }
  if (![obj.baseHead, obj.candidateHead, obj.mergeCommit].every(v => typeof v === 'string' && GUARDIAN_SHA_RE.test(v))) {
    throw new Error('invalid manifest SHA');
  }
  return obj as unknown as DetachedPostMergeRunnerInput;
}

/** Canonical SHA-256 identity key binding all required and optional manifest fields. */
export function guardianVerificationKey(input: DetachedPostMergeRunnerInput): string {
  return createHash('sha256').update(JSON.stringify(ALL_FIELDS.map(k => input[k] ?? null))).digest('hex');
}

function isValidStateEntry(value: unknown): value is GuardianStateEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as GuardianStateEntry;
  return /^[a-f0-9]{64}$/.test(e.key) && typeof e.repo === 'string' && isAbsolute(e.repo)
    && e.repo.length <= GUARDIAN_MAX_PATH_LENGTH && GUARDIAN_SHA_RE.test(e.sha)
    && ['pass', 'fail', 'unknown'].includes(e.terminal)
    && typeof e.checkedAt === 'string' && !Number.isNaN(Date.parse(e.checkedAt))
    && GUARDIAN_REASONS.has(e.reason)
    && (e.failureCategory === null || GUARDIAN_FAILURE_CATEGORIES.has(e.failureCategory))
    && GUARDIAN_CLEANUPS.has(e.cleanup)
    && Object.keys(value).sort().join(',') === 'checkedAt,cleanup,failureCategory,key,reason,repo,sha,terminal';
}

async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  if ((await stat(path)).size > maxBytes) throw new Error('input too large');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('input too large');
  return JSON.parse(text) as unknown;
}

export async function readGuardianManifest(path: string): Promise<DetachedPostMergeRunnerInput[]> {
  const raw = await readBoundedJson(path, MANIFEST_MAX_BYTES);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > GUARDIAN_MANIFEST_MAX_ENTRIES) {
    throw new Error('manifest must contain 1 to 100 entries');
  }
  const inputs = raw.map(validateManifestInput);
  const seen = new Map<string, string>();
  for (const input of inputs) {
    const identity = `${resolve(input.repo)}\0${input.mergeCommit}`;
    const prior = seen.get(identity);
    const k = guardianVerificationKey(input);
    if (prior !== undefined) throw new Error(prior === k ? 'duplicate manifest entry' : 'conflicting manifest entry');
    seen.set(identity, k);
  }
  return inputs;
}

export async function readGuardianState(path: string, options: { allowMissing?: boolean } = {}): Promise<GuardianState> {
  let raw: unknown;
  try {
    raw = await readBoundedJson(path, STATE_MAX_BYTES);
  } catch (error) {
    if (options.allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    throw error;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid state');
  const state = raw as GuardianState;
  if (Object.keys(raw).sort().join(',') !== 'entries,version' || state.version !== 1
    || !Array.isArray(state.entries) || state.entries.length > GUARDIAN_STATE_MAX_ENTRIES
    || !state.entries.every(isValidStateEntry)
    || new Set(state.entries.map(e => e.key)).size !== state.entries.length) {
    throw new Error('invalid state');
  }
  return state;
}

/** Create a new mode-0600 file exclusively (wx); remove any partial file on non-EEXIST error. */
export async function writePrivateExclusive(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await unlink(path).catch(() => {});
    throw error;
  }
}

/** Atomically replace a mode-0600 file via a same-directory temp file + rename. */
export async function writePrivateAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
