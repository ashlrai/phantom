import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkReturnPrs, type ReturnEvidenceRow } from '../src/core/fleet/return-pr-check.js';

const rows: ReturnEvidenceRow[] = [1, 2, 3].map(pr => ({
  claimId: `fake-${pr}`, repo: 'example/demo', result: 'VERIFIED', evidenceKind: 'pr', pr, head: `abc123${pr}`,
}));
const body = JSON.stringify({ state: 'open', head: { sha: 'abc1234000000000000000000000000000000000' } });
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); });

describe('in-flight return check deadline', () => {
  it.each([100, 101])('rejects a read settling at clock deadline %s before the timer runs', async elapsed => {
    let clock = 0;
    const gh = vi.fn(async () => { clock = elapsed; return body; });
    const report = await checkReturnPrs(rows, { gh, now: () => clock, timeoutMs: 100 });
    expect(report.checked.map(row => [row.verdict, row.reason])).toEqual([
      ['unknown', 'deadline'], ['unknown', 'deadline'], ['unknown', 'deadline'],
    ]);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it('returns all selected provenance at the deadline and ignores a late success', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const gh = vi.fn(() => pending.promise);
    const reportPromise = checkReturnPrs(rows, { gh, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const report = await reportPromise;
    expect(gh).toHaveBeenCalledTimes(1);
    expect(report.checked).toEqual(rows.map(({ claimId, repo, pr, head }) => ({
      claimId, repo, pr, head, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'deadline',
    })));
    const snapshot = structuredClone(report);
    pending.resolve(body);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toEqual(snapshot);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it('clears an early timer and starts the next read within the remaining budget', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const gh = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const reportPromise = checkReturnPrs(rows.slice(0, 2), { gh, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(40);
    first.resolve(body);
    await vi.advanceTimersByTimeAsync(0);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    const report = await reportPromise;
    expect(report.checked.map(row => [row.verdict, row.reason])).toEqual([['open', undefined], ['unknown', 'deadline']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles rejection after the deadline', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const reportPromise = checkReturnPrs(rows, { gh: () => pending.promise, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await reportPromise).checked[0]?.reason).toBe('deadline');
    pending.reject(new Error('fake late failure'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('launches no reads with a zero budget', async () => {
    const gh = vi.fn(async () => body);
    const report = await checkReturnPrs(rows, { gh, timeoutMs: 0 });
    expect(gh).not.toHaveBeenCalled();
    expect(report.checked.map(row => row.reason)).toEqual(['deadline', 'deadline', 'deadline']);
  });
});
