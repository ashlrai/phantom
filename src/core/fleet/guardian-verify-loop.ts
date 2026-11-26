import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  runDetachedPostMergeVerification,
  type DetachedPostMergeRunnerInput,
  type DetachedPostMergeRunnerResult,
} from './detached-post-merge-runner.js';
import {
  GUARDIAN_CLEANUPS,
  GUARDIAN_FAILURE_CATEGORIES,
  GUARDIAN_REASONS,
  GUARDIAN_STATE_MAX_ENTRIES,
  guardianVerificationKey,
  readGuardianManifest,
  readGuardianState,
  writePrivateAtomic,
  type GuardianStateEntry,
} from './guardian-schema.js';

export const GUARDIAN_VERIFY_MAX_TIMEOUT_MS = 86_400_000;
export const GUARDIAN_VERIFY_DEADLINE: unique symbol = Symbol('guardian-verify-deadline');
export interface GuardianOptions {
  manifest: string;
  state: string;
  maxPasses: number;
  intervalMs: number;
  /**
   * Total elapsed-time budget in milliseconds: a positive safe integer of at most
   * GUARDIAN_VERIFY_MAX_TIMEOUT_MS (one day). When omitted the loop has no total
   * deadline. The caller composes it with SIGINT/SIGTERM through the AbortController
   * behind `signal`, expiring it with `abort(GUARDIAN_VERIFY_DEADLINE)`; the loop then
   * records deadline-interrupted work as 'verification-timeout'/'timeout', sets
   * `deadlineExceeded` on the summary and leaves `cancelled` false.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  run?: typeof runDetachedPostMergeVerification;
}
export interface GuardianSummary { passes: number; pass: number; fail: number; unknown: number; cancelled: boolean; deadlineExceeded: boolean }

function entry(input: DetachedPostMergeRunnerInput, result: DetachedPostMergeRunnerResult | null, interrupted: boolean, deadline: boolean): GuardianStateEntry {
  const terminal = !interrupted && result && ['pass', 'fail', 'unknown'].includes(result.terminal) ? result.terminal : 'unknown';
  return { key: guardianVerificationKey(input), repo: resolve(input.repo), sha: input.mergeCommit, terminal, checkedAt: new Date().toISOString(),
    reason: result && GUARDIAN_REASONS.has(result.reason) && !interrupted ? result.reason : deadline ? 'verification-timeout' : 'verification-infrastructure',
    failureCategory: interrupted ? (deadline ? 'timeout' : 'cancelled') : result?.failureCategory && GUARDIAN_FAILURE_CATEGORIES.has(result.failureCategory) ? result.failureCategory : null,
    cleanup: result && GUARDIAN_CLEANUPS.has(result.cleanup) ? result.cleanup : 'failed' };
}
export async function runGuardianVerifyLoop(options: GuardianOptions): Promise<GuardianSummary> {
  if (!isAbsolute(options.manifest) || !isAbsolute(options.state) || options.manifest === options.state ||
    !Number.isSafeInteger(options.maxPasses) || options.maxPasses < 1 || options.maxPasses > 100 ||
    !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 60000 ||
    (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > GUARDIAN_VERIFY_MAX_TIMEOUT_MS))) throw new Error('invalid paths or bounds');
  const state = await readGuardianState(options.state, { allowMissing: true });
  const summary: GuardianSummary = { passes: 0, pass: 0, fail: 0, unknown: 0, cancelled: false, deadlineExceeded: false };
  for (let pass = 0; pass < options.maxPasses && !options.signal?.aborted; pass++) {
    const inputs = await readGuardianManifest(options.manifest);
    summary.passes++;
    summary.pass = 0; summary.fail = 0; summary.unknown = 0;
    for (const input of inputs) {
      if (options.signal?.aborted) break;
      const k = guardianVerificationKey(input);
      let existing = state.entries.find(e => e.key === k);
      if (existing && (existing.repo !== resolve(input.repo) || existing.sha !== input.mergeCommit)) throw new Error('state identity mismatch');
      if (!existing || existing.terminal === 'unknown') {
        if (!existing && state.entries.length >= GUARDIAN_STATE_MAX_ENTRIES) throw new Error('state capacity exceeded');
        let result: DetachedPostMergeRunnerResult | null = null;
        try { result = await (options.run ?? runDetachedPostMergeVerification)(input, { signal: options.signal }); } catch { /* infrastructure failure */ }
        existing = entry(input, result, options.signal?.aborted === true, options.signal?.reason === GUARDIAN_VERIFY_DEADLINE);
        state.entries = state.entries.filter(e => e.key !== k);
        state.entries.push(existing);
        await writePrivateAtomic(options.state, JSON.stringify(state));
      }
      summary[existing.terminal]++;
    }
    if (pass + 1 < options.maxPasses && !options.signal?.aborted) {
      try { await delay(options.intervalMs, undefined, { signal: options.signal }); } catch (error) {
        if (!options.signal?.aborted) throw error;
      }
    }
  }
  summary.deadlineExceeded = options.signal?.reason === GUARDIAN_VERIFY_DEADLINE;
  summary.cancelled = options.signal?.aborted === true && !summary.deadlineExceeded;
  return summary;
}
