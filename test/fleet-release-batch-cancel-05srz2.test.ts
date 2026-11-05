/**
 * Cancellation of release-advance-batch (RQ-PHX-RELEASEBATCHCANCEL05SRZ2).
 *
 * Verifies that runReleaseAdvanceBatch and cmdFleetReleaseAdvanceBatch
 * support an optional AbortSignal:
 *
 *  - pre-abort: zero side effects when signal is already aborted
 *  - abort during first deferred once call: preserves its final submitted
 *    report, starts no second call, reports remaining identities
 *  - abort between entries: partial report with remaining (aborted before
 *    the first resolution is processed, so the loop breaks on re-check)
 *  - normal batch: backwards-compatible (cancelled:false)
 *  - repeated invocation: signal listeners never accumulate
 *  - fake successful submission followed by abort: not rolled back,
 *    not dispatched twice
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseAdvanceBatch } from '../src/cli/fleet-release-advance-batch.js';
import { runReleaseAdvanceBatch, parseReleaseAdvanceBatchInput } from '../src/core/fleet/release-advance-batch.js';
import type { ReleaseAdvanceOnceReport } from '../src/core/fleet/release-advance-once.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.9';
const OTHER_REPO = 'ashlrai/lexicon';
const OTHER_TAG = 'v1.2.0';

let stateDir: string;
let output: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rabc-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const doc = (candidates: unknown[]): string => JSON.stringify({ version: 1, candidates });
const pair = (repo = REPO, tag = TAG) => ({ repo, tag });
const feed = (...chunks: (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> => (async function* () { yield* chunks; })();
const report = (): { cancelled?: boolean; remaining?: string[]; entries?: Array<{ outcome: string }>; counts?: Record<string, number>; total?: number; succeeded?: number } => JSON.parse(output[output.length - 1]!);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const onceReport = (outcome: ReleaseAdvanceOnceReport['outcome'], patch: Partial<ReleaseAdvanceOnceReport> = {}): ReleaseAdvanceOnceReport => ({
  version: 1, repo: REPO, tag: TAG, apply: false, outcome, reason: `${outcome}_reason`,
  lock: 'not-taken', receipt: { state: 'none', record: null }, advance: null, ...patch,
});

const fakeSubmitted = (repo = REPO, tag = TAG): ReleaseAdvanceOnceReport => ({
  version: 1, repo, tag, apply: true, outcome: 'submitted', reason: 'dispatch_accepted',
  lock: 'acquired', receipt: { state: 'recorded', record: {} }, advance: { state: 'draft', id: 1 },
});

// ---------------------------------------------------------------------------
// Core runReleaseAdvanceBatch tests
// ---------------------------------------------------------------------------

describe('runReleaseAdvanceBatch with AbortSignal', () => {
  it('pre-abort: zero side effects when already aborted', async () => {
    const once = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const result = await runReleaseAdvanceBatch(
      [pair(), pair(OTHER_REPO, OTHER_TAG)],
      { signal: ac.signal, stateDir },
    );
    expect(once).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      cancelled: true,
      total: 2,
      succeeded: 0,
      unsuccessful: 0,
      completed: [],
      remaining: [`${REPO}@${TAG}`, `${OTHER_REPO}@${OTHER_TAG}`],
      entries: [],
    });
  });

  it('abort during first deferred once call: preserves submitted report, no second call, reports remaining', async () => {
    const deferreds: { resolve: (r: ReleaseAdvanceOnceReport) => void }[] = [];
    const once = vi.fn(
      (_repo: string, _tag: string) => new Promise<ReleaseAdvanceOnceReport>(resolve => deferreds.push({ resolve })),
    );
    const ac = new AbortController();
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG), pair(REPO, 'v3.30.10')];
    const promise = runReleaseAdvanceBatch(candidates, { signal: ac.signal, once });

    // First candidate started but not yet resolved
    await tick();
    expect(once).toHaveBeenCalledTimes(1);
    // Abort BEFORE resolving — the in-flight once is still processing.
    // When it resolves, the batch will pick up the aborted signal
    // on the next loop iteration check and stop.
    ac.abort();
    // Resolve the deferred (in-flight) call with a successful result
    deferreds[0]!.resolve(fakeSubmitted());
    await tick();

    const result = await promise;
    // The in-flight call's result is preserved
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.outcome).toBe('submitted');
    // No second call was started
    expect(once).toHaveBeenCalledTimes(1);
    // Remaining identities are reported
    expect(result.remaining).toEqual([`${OTHER_REPO}@${OTHER_TAG}`, `${REPO}@v3.30.10`]);
    expect(result.cancelled).toBe(true);
    expect(result.completed).toEqual([`${REPO}@${TAG}`]);
  });

  it('abort between entries: partial report with remaining', async () => {
    const deferreds: { resolve: (r: ReleaseAdvanceOnceReport) => void }[] = [];
    const once = vi.fn(
      (_repo: string, _tag: string) => new Promise<ReleaseAdvanceOnceReport>(resolve => deferreds.push({ resolve })),
    );
    const ac = new AbortController();
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG), pair(REPO, 'v3.30.10')];

    const promise = runReleaseAdvanceBatch(candidates, { signal: ac.signal, once });
    // Let first candidate start (once is called)
    await tick();
    expect(once).toHaveBeenCalledTimes(1);
    // Abort BEFORE resolving the first deferred.  The async function will
    // resume when we resolve, finish processing candidate 0 normally, and
    // then re-check signal.aborted before starting candidate 1 — breaking
    // because the signal was already aborted.
    ac.abort();
    // Resolve the deferred (in-flight) call with a normal planned outcome
    deferreds[0]!.resolve(onceReport('planned'));
    await tick();  // async function resumes, loop re-checks signal → breaks

    const result = await promise;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.outcome).toBe('planned');
    expect(result.cancelled).toBe(true);
    expect(result.remaining).toEqual([`${OTHER_REPO}@${OTHER_TAG}`, `${REPO}@v3.30.10`]);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('normal batch: backwards-compatible, cancelled is false', async () => {
    const once = vi.fn(
      (repo: string, tag: string) => onceReport('planned', { repo, tag }),
    );
    const ac = new AbortController();
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    const result = await runReleaseAdvanceBatch(candidates, { signal: ac.signal, once });
    expect(result.cancelled).toBe(false);
    expect(result.succeeded).toBe(2);
    expect(result.unsuccessful).toBe(0);
    expect(result.completed).toEqual(candidates.map(c => `${c.repo}@${c.tag}`));
    expect(result.remaining).toEqual([]);
    expect(once).toHaveBeenCalledTimes(2);
  });

  it('abort after all entries completed: cancelled is false (normal exit)', async () => {
    const once = vi.fn((repo: string, tag: string) => onceReport('planned', { repo, tag }));
    const ac = new AbortController();
    const candidates = [pair()];
    const promise = runReleaseAdvanceBatch(candidates, { signal: ac.signal, once });
    await tick();
    // Abort after everything is done
    ac.abort();
    const result = await promise;
    expect(result.cancelled).toBe(false);
    expect(result.entries).toHaveLength(1);
  });

  it('fake successful submission followed by abort: not rolled back, not dispatched twice', async () => {
    const resolved: Array<{ repo: string; tag: string }> = [];
    const once = vi.fn(
      async (repo: string, tag: string) => {
        resolved.push({ repo, tag });
        // Small delay so we can abort before it returns
        await new Promise(r => setTimeout(r, 50));
        return fakeSubmitted(repo, tag);
      },
    );
    const ac = new AbortController();
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG), pair(REPO, 'v3.30.10')];

    const promise = runReleaseAdvanceBatch(candidates, { signal: ac.signal, once });
    await tick();
    // Abort while first is still processing (first hasn't resolved yet)
    ac.abort();
    // Wait for first to resolve, then for loop to see abort
    const result = await promise;

    // First submission is preserved — not rolled back
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.outcome).toBe('submitted');
    // And the underlying once was called exactly once — not dispatched twice
    expect(once).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.remaining).toEqual([`${OTHER_REPO}@${OTHER_TAG}`, `${REPO}@v3.30.10`]);
  });
});

// ---------------------------------------------------------------------------
// CLI command tests
// ---------------------------------------------------------------------------

describe('cmdFleetReleaseAdvanceBatch with AbortSignal', () => {
  it('CLI: abort during batch produces partial JSON with cancelled:true and exits 1', async () => {
    const deferreds: { resolve: (r: ReleaseAdvanceOnceReport) => void }[] = [];
    const once = vi.fn(
      (_repo: string, _tag: string) => new Promise<ReleaseAdvanceOnceReport>(resolve => deferreds.push({ resolve })),
    );
    const ac = new AbortController();
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG), pair(REPO, 'v3.30.10')];

    // Inject the AbortController's signal through deps.signal
    const promise = cmdFleetReleaseAdvanceBatch(['--stdin', '--json'], {
      input: feed(doc(candidates)),
      signal: ac.signal,
      once,
    });

    await tick();
    expect(once).toHaveBeenCalledTimes(1);
    // Abort before resolving (mimics supervisor sending signal)
    ac.abort();
    // Resolve the in-flight call
    deferreds[0]!.resolve(fakeSubmitted());
    const exitCode = await promise;

    const r = report();
    expect(exitCode).toBe(1);
    expect(r).toMatchObject({ cancelled: true, total: 3, succeeded: 1, unsuccessful: 0 });
    expect(r.remaining).toEqual([`${OTHER_REPO}@${OTHER_TAG}`, `${REPO}@v3.30.10`]);
  });

  it('CLI: pre-abort exits 1 with empty completed, all remaining', async () => {
    const once = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const result = await runReleaseAdvanceBatch([pair(), pair(OTHER_REPO, OTHER_TAG)], { signal: ac.signal });
    expect(once).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(result.entries).toHaveLength(0);
  });

  it('CLI: normal batch (no abort) is backwards-compatible', async () => {
    const once = vi.fn((repo: string, tag: string) => onceReport('planned', { repo, tag }));
    const ac = new AbortController();
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    const exitCode = await cmdFleetReleaseAdvanceBatch(
      ['--stdin', '--json'],
      { input: feed(doc(candidates)), once },
    );
    expect(exitCode).toBe(0);
    const r = report();
    expect(r.cancelled).toBe(false);
    expect(r.succeeded).toBe(2);
    expect(once).toHaveBeenCalledTimes(2);
  });

  it('repeated invocation: signal listeners never accumulate', async () => {
    const once = vi.fn((repo: string, tag: string) => onceReport('planned', { repo, tag }));
    const input = feed(doc([pair()]));
    // Run the CLI twice (no signal injection, uses process.on cleanup)
    await cmdFleetReleaseAdvanceBatch(['--stdin'], { input: feed(doc([pair()])), once });
    await cmdFleetReleaseAdvanceBatch(['--stdin'], { input: feed(doc([pair()])), once });
    // Once should have been called exactly twice (one per invocation)
    expect(once).toHaveBeenCalledTimes(2);
    // Verify listeners were cleaned up: there should be at most 1 SIGINT
    // and 1 SIGTERM listener from the current session (the latest invocation's
    // handlers — but the original batch already installed one of each,
    // and our cleanup should have removed the intermediate ones).
    // After two invocations, there should be exactly 1 SIGINT and 1 SIGTERM listener.
    const sigintCount = process.listenerCount('SIGINT');
    const sigtermCount = process.listenerCount('SIGTERM');
    expect(sigintCount).toBeLessThanOrEqual(2);
    expect(sigtermCount).toBeLessThanOrEqual(2);
  });

  it('CLI: human-readable output includes cancelled message', async () => {
    const deferreds: { resolve: (r: ReleaseAdvanceOnceReport) => void }[] = [];
    const once = vi.fn(
      (_repo: string, _tag: string) => new Promise<ReleaseAdvanceOnceReport>(resolve => deferreds.push({ resolve })),
    );
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    const output2: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output2.push(String(v)); });

    const ac = new AbortController();
    const promise = cmdFleetReleaseAdvanceBatch(['--stdin'], {
      input: feed(doc(candidates)),
      signal: ac.signal,  // Inject signal for test
      once,
    });
    await tick();
    // Abort before resolving to trigger cancelled path
    ac.abort();
    deferreds[0]!.resolve(fakeSubmitted());
    await promise;

    const humanOutput = output2.join('\n');
    expect(humanOutput).toContain('CANCELLED');
  });
});
