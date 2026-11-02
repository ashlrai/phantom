import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  runDetachedPostMergeVerification,
  type DetachedPostMergeRunnerInput,
  type DetachedPostMergeRunnerResult,
} from './detached-post-merge-runner.js';

type Terminal = 'pass' | 'fail' | 'unknown';
type Entry = { key: string; repo: string; sha: string; terminal: Terminal; checkedAt: string; reason: string; failureCategory: string | null; cleanup: string };
type State = { version: 1; entries: Entry[] };
export interface GuardianOptions {
  manifest: string;
  state: string;
  maxPasses: number;
  intervalMs: number;
  signal?: AbortSignal;
  run?: typeof runDetachedPostMergeVerification;
}
export interface GuardianSummary { passes: number; pass: number; fail: number; unknown: number; cancelled: boolean }

const required = ['repo', 'cohortId', 'proposalId', 'baseBranch', 'baseHead', 'candidateHead', 'mergeCommit'] as const;
const optional = ['runId', 'trajectoryId', 'workItemId'] as const;
const sha = /^[a-f0-9]{40}$/;
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
    if (typeof v !== 'string' || !(k === 'repo' ? v.length <= 4096 && isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v) : safeText.test(v))) throw new Error(`invalid manifest ${k}`);
  }
  if (![obj.baseHead, obj.candidateHead, obj.mergeCommit].every(v => typeof v === 'string' && sha.test(v))) throw new Error('invalid manifest SHA');
  return obj as unknown as DetachedPostMergeRunnerInput;
}
function key(input: DetachedPostMergeRunnerInput): string {
  return createHash('sha256').update(JSON.stringify([...required, ...optional].map(k => input[k] ?? null))).digest('hex');
}
async function manifest(path: string): Promise<DetachedPostMergeRunnerInput[]> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
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
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    throw error;
  }
  const s: unknown = JSON.parse(text);
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('invalid state');
  const state = s as State;
  if (Object.keys(s).sort().join(',') !== 'entries,version' || state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 1000 || !state.entries.every(validEntry) || new Set(state.entries.map(e => e.key)).size !== state.entries.length) throw new Error('invalid state');
  return state;
}
async function save(path: string, state: State): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
function entry(input: DetachedPostMergeRunnerInput, result: DetachedPostMergeRunnerResult | null, interrupted: boolean): Entry {
  const terminal = !interrupted && result && ['pass', 'fail', 'unknown'].includes(result.terminal) ? result.terminal : 'unknown';
  return { key: key(input), repo: resolve(input.repo), sha: input.mergeCommit, terminal, checkedAt: new Date().toISOString(),
    reason: result && reasons.has(result.reason) && !interrupted ? result.reason : 'verification-infrastructure',
    failureCategory: interrupted ? 'cancelled' : result?.failureCategory && categories.has(result.failureCategory) ? result.failureCategory : null,
    cleanup: result && cleanups.has(result.cleanup) ? result.cleanup : 'failed' };
}
export async function runGuardianVerifyLoop(options: GuardianOptions): Promise<GuardianSummary> {
  if (!isAbsolute(options.manifest) || !isAbsolute(options.state) || options.manifest === options.state ||
    !Number.isSafeInteger(options.maxPasses) || options.maxPasses < 1 || options.maxPasses > 100 ||
    !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 60000) throw new Error('invalid paths or bounds');
  const state = await readState(options.state);
  const summary: GuardianSummary = { passes: 0, pass: 0, fail: 0, unknown: 0, cancelled: false };
  for (let pass = 0; pass < options.maxPasses && !options.signal?.aborted; pass++) {
    const inputs = await manifest(options.manifest);
    summary.passes++;
    summary.pass = 0; summary.fail = 0; summary.unknown = 0;
    for (const input of inputs) {
      if (options.signal?.aborted) break;
      const k = key(input);
      let existing = state.entries.find(e => e.key === k);
      if (existing && (existing.repo !== resolve(input.repo) || existing.sha !== input.mergeCommit)) throw new Error('state identity mismatch');
      if (!existing || existing.terminal === 'unknown') {
        if (!existing && state.entries.length >= 1000) throw new Error('state capacity exceeded');
        let result: DetachedPostMergeRunnerResult | null = null;
        try { result = await (options.run ?? runDetachedPostMergeVerification)(input, { signal: options.signal }); } catch { /* infrastructure failure */ }
        existing = entry(input, result, options.signal?.aborted === true);
        state.entries = state.entries.filter(e => e.key !== k);
        state.entries.push(existing);
        await save(options.state, state);
      }
      summary[existing.terminal]++;
    }
    if (pass + 1 < options.maxPasses && !options.signal?.aborted) {
      try { await delay(options.intervalMs, undefined, { signal: options.signal }); } catch (error) {
        if (!options.signal?.aborted) throw error;
      }
    }
  }
  summary.cancelled = options.signal?.aborted === true;
  return summary;
}
