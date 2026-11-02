// Manifest schema, entry schema and verification-key calculation deliberately
// mirror src/core/fleet/guardian-verify-loop.ts so compacted output stays a valid
// input to runGuardianVerifyLoop. Do not edit that file; keep these copies in sync.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DetachedPostMergeRunnerInput } from './detached-post-merge-runner.js';

type Terminal = 'pass' | 'fail' | 'unknown';
type Entry = { key: string; repo: string; sha: string; terminal: Terminal; checkedAt: string; reason: string; failureCategory: string | null; cleanup: string };
type State = { version: 1; entries: Entry[] };
export interface GuardianCompactOptions { manifest: string; sourceState: string; outputState: string }
export interface GuardianCompactResult { before: number; retained: number; removed: number }

const MANIFEST_MAX_BYTES = 1_048_576; // 100 entries x ~6 KB worst-case manifest row
const STATE_MAX_BYTES = 8_388_608; // 1000 entries x ~4.5 KB worst-case state row
const required = ['repo', 'cohortId', 'proposalId', 'baseBranch', 'baseHead', 'candidateHead', 'mergeCommit'] as const;
const optional = ['runId', 'trajectoryId', 'workItemId'] as const;
const sha = /^[a-f0-9]{40}$/;
// eslint-disable-next-line no-control-regex -- mirrors the guardian-verify-loop control-character guard
const safeText = /^[^\x00-\x1f\x7f]{1,256}$/;
const reasons = new Set(['verified', 'code-failure', 'verification-infrastructure', 'verification-timeout', 'invalid-input', 'source-unavailable', 'binding-mismatch', 'worktree-create-failed', 'manifest-unavailable', 'isolation-lost', 'cleanup-failed', 'record-rejected']);
const categories = new Set(['code', 'infra', 'timeout', 'cancelled']);
const cleanups = new Set(['removed', 'failed', 'not-created']);

function validateInput(value: unknown): DetachedPostMergeRunnerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest entry');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => ![...required, ...optional].includes(k as typeof required[number]))) throw new Error('unexpected manifest field');
  for (const k of [...required, ...optional]) {
    const v = obj[k];
    if (v === undefined && (optional as readonly string[]).includes(k)) continue;
    // eslint-disable-next-line no-control-regex -- mirrors the guardian-verify-loop control-character guard
    if (typeof v !== 'string' || !(k === 'repo' ? v.length <= 4096 && isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v) : safeText.test(v))) throw new Error(`invalid manifest ${k}`);
  }
  if (![obj.baseHead, obj.candidateHead, obj.mergeCommit].every(v => typeof v === 'string' && sha.test(v))) throw new Error('invalid manifest SHA');
  return obj as unknown as DetachedPostMergeRunnerInput;
}
function key(input: DetachedPostMergeRunnerInput): string {
  return createHash('sha256').update(JSON.stringify([...required, ...optional].map(k => input[k] ?? null))).digest('hex');
}
async function readJsonBounded(path: string, maxBytes: number): Promise<unknown> {
  if ((await stat(path)).size > maxBytes) throw new Error('input too large');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function readManifest(path: string): Promise<DetachedPostMergeRunnerInput[]> {
  const raw = await readJsonBounded(path, MANIFEST_MAX_BYTES);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) throw new Error('manifest must contain 1 to 100 entries');
  const inputs = raw.map(validateInput);
  const seen = new Map<string, string>();
  for (const input of inputs) {
    const identity = `${resolve(input.repo)}\0${input.mergeCommit}`;
    const prior = seen.get(identity);
    if (prior !== undefined) throw new Error(prior === key(input) ? 'duplicate manifest entry' : 'conflicting manifest entry');
    seen.set(identity, key(input));
  }
  return inputs;
}
function validEntry(v: unknown): v is Entry {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Entry;
  return /^[a-f0-9]{64}$/.test(e.key) && typeof e.repo === 'string' && isAbsolute(e.repo) && e.repo.length <= 4096 && sha.test(e.sha) &&
    ['pass', 'fail', 'unknown'].includes(e.terminal) && typeof e.checkedAt === 'string' && !Number.isNaN(Date.parse(e.checkedAt)) &&
    reasons.has(e.reason) && (e.failureCategory === null || categories.has(e.failureCategory)) && cleanups.has(e.cleanup) &&
    Object.keys(v).sort().join(',') === 'checkedAt,cleanup,failureCategory,key,reason,repo,sha,terminal';
}
async function readState(path: string): Promise<State> {
  const s = await readJsonBounded(path, STATE_MAX_BYTES);
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('invalid state');
  const state = s as State;
  if (Object.keys(s).sort().join(',') !== 'entries,version' || state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 1000 || !state.entries.every(validEntry) || new Set(state.entries.map(e => e.key)).size !== state.entries.length) throw new Error('invalid state');
  return state;
}
async function canonicalExisting(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return realpath(path).catch(() => { throw new Error(`${label} missing or unreadable`); });
}

/** Compact a guardian state to entries whose key is in the manifest. Pure read of inputs; output created 0600 exclusively. */
export async function compactGuardianState(options: GuardianCompactOptions): Promise<GuardianCompactResult> {
  const manifestPath = await canonicalExisting(options.manifest, 'manifest');
  const sourcePath = await canonicalExisting(options.sourceState, 'source state'); // missing state is an error, never emptied
  if (!isAbsolute(options.outputState)) throw new Error('output state must be absolute');
  const outputPath = join(await realpath(dirname(options.outputState)).catch(() => { throw new Error('output directory missing or unreadable'); }), basename(options.outputState));
  if (sourcePath === outputPath || manifestPath === outputPath || manifestPath === sourcePath) throw new Error('manifest, source and output paths must be distinct');
  if (await lstat(outputPath).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; return false; })) throw new Error('output already exists');
  const keys = new Set((await readManifest(manifestPath)).map(key));
  const state = await readState(sourcePath);
  const entries = state.entries.filter(e => keys.has(e.key)); // order and values preserved unchanged
  const output: State = { version: 1, entries };
  try {
    await writeFile(outputPath, JSON.stringify(output), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await unlink(outputPath).catch(() => {}); // drop only a partial file this call created
    throw error;
  }
  return { before: state.entries.length, retained: entries.length, removed: state.entries.length - entries.length };
}
