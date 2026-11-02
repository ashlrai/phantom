import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { DetachedPostMergeRunnerInput } from './detached-post-merge-runner.js';

type Terminal = 'pass' | 'fail' | 'unknown';
type Entry = { key: string; repo: string; sha: string; terminal: Terminal; checkedAt: string; reason: string; failureCategory: string | null; cleanup: string };
type State = { version: 1; entries: Entry[] };

const MAX_BYTES = 1_048_576;
const required = ['repo', 'cohortId', 'proposalId', 'baseBranch', 'baseHead', 'candidateHead', 'mergeCommit'] as const;
const optional = ['runId', 'trajectoryId', 'workItemId'] as const;
const sha = /^[a-f0-9]{40}$/;
// Literal-equivalent of the guardian-verify-loop safeText rule `^[^\x00-\x1f\x7f]{1,256}$`,
// written without a control-char regex so the lint surface stays clean. Length
// is measured in UTF-16 code units, exactly like the upstream regex.
const isSafeText = (v: string): boolean => v.length >= 1 && v.length <= 256 && [...v].every(c => { const n = c.codePointAt(0)!; return n > 0x1f && n !== 0x7f; });
const reasons = new Set(['verified', 'code-failure', 'verification-infrastructure', 'verification-timeout', 'invalid-input', 'source-unavailable', 'binding-mismatch', 'worktree-create-failed', 'manifest-unavailable', 'isolation-lost', 'cleanup-failed', 'record-rejected']);
const categories = new Set(['code', 'infra', 'timeout', 'cancelled']);
const cleanups = new Set(['removed', 'failed', 'not-created']);

// The manifest/state schema checks below mirror the private validators in
// guardian-verify-loop.ts exactly; that module does not export them, and the
// retry path must validate against the same rules the loop enforces.
function validateInput(value: unknown): DetachedPostMergeRunnerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest entry');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => ![...required, ...optional].includes(k as typeof required[number]))) throw new Error('unexpected manifest field');
  for (const k of [...required, ...optional]) {
    const v = obj[k];
    if (v === undefined && (optional as readonly string[]).includes(k)) continue;
    if (typeof v !== 'string' || !(k === 'repo' ? v.length >= 1 && v.length <= 4096 && isAbsolute(v) && isSafeText(v) : isSafeText(v))) throw new Error(`invalid manifest ${k}`);
  }
  if (![obj.baseHead, obj.candidateHead, obj.mergeCommit].every(v => typeof v === 'string' && sha.test(v))) throw new Error('invalid manifest SHA');
  return obj as unknown as DetachedPostMergeRunnerInput;
}
function key(input: DetachedPostMergeRunnerInput): string {
  return createHash('sha256').update(JSON.stringify([...required, ...optional].map(k => input[k] ?? null))).digest('hex');
}
async function readBounded(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_BYTES) throw new Error('input too large');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('input too large');
  return text;
}
async function manifest(path: string): Promise<DetachedPostMergeRunnerInput[]> {
  const raw: unknown = JSON.parse(await readBounded(path));
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
async function readSourceState(path: string): Promise<State> {
  const s: unknown = JSON.parse(await readBounded(path));
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('invalid state');
  const state = s as State;
  if (Object.keys(s).sort().join(',') !== 'entries,version' || state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 1000 || !state.entries.every(validEntry) || new Set(state.entries.map(e => e.key)).size !== state.entries.length) throw new Error('invalid state');
  return state;
}
// Validate the entire input before reporting no work, using the same schemas as
// retry preparation. The key binds every manifest field, including optional IDs.
export async function selectNextGuardianInfraRetry(options: { manifest: string; sourceState: string; outputState: string }): Promise<{ repo: string; sha: string } | null> {
  if (![options.manifest, options.sourceState, options.outputState].every(p => isAbsolute(p) && p.length <= 4096) ||
    resolve(options.sourceState) === resolve(options.outputState)) throw new Error('invalid guardian-retry paths');
  const inputs = await manifest(options.manifest);
  const state = await readSourceState(options.sourceState);
  const identities = new Map(inputs.map(input => [key(input), input]));
  const eligible = state.entries.filter(e => {
    const input = identities.get(e.key);
    return input !== undefined && resolve(input.repo) === resolve(e.repo) && input.mergeCommit === e.sha &&
      e.terminal === 'fail' && e.failureCategory === 'infra' && (e.cleanup === 'removed' || e.cleanup === 'not-created');
  });
  eligible.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const selected = eligible[0];
  return selected ? { repo: selected.repo, sha: selected.sha } : null;
}
