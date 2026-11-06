import { describe, expect, it } from 'vitest';
import { attributeMergeWait, collectMergeEtas, estimateMergeEta, formatMergeEta, readMergeHistory, recutRequest } from '../src/core/merge-eta.js';

const history = readMergeHistory(new URL('./fixtures/merge-eta/history.json', import.meta.url).pathname);
const estimate = (position: number | null, checks = ['build', 'test']) =>
  estimateMergeEta('ashlrai/phantom', 42, position, checks, history);

describe('merge ETA', () => {
  it('reads fixture history and takes the slowest parallel check', () => {
    expect(history).toHaveLength(5);
    expect(estimate(1).rangeMinutes).toEqual([5, 8]);
    expect(estimate(3).rangeMinutes).toEqual([15, 24]);
    expect(formatMergeEta(estimate(3))).toBe('PR #42: merge ETA 15–24 min (queue #3)');
  });
  it('does not invent history, required checks or queue positions', () => {
    for (const position of [null, 0, -1, 1.5, NaN, Infinity]) expect(estimate(position).rangeMinutes).toBeNull();
    expect(estimate(1, []).rangeMinutes).toBeNull();
    expect(estimate(1, ['missing']).rangeMinutes).toBeNull();
    expect(estimateMergeEta('other/repo', 42, 1, ['test'], history).rangeMinutes).toBeNull();
    expect(estimateMergeEta('ashlrai/phantom', 42, 1, ['test'], []).rangeMinutes).toBeNull();
    expect(formatMergeEta(estimate(null))).toContain('merge ETA unknown');
  });
  it('treats unreadable or malformed history as unavailable', () => {
    expect(readMergeHistory('/nonexistent/merge-eta-history')).toEqual([]);
    expect(readMergeHistory(new URL('./status-duration-estimate.test.ts', import.meta.url).pathname)).toEqual([]);
  });
  it('collects real queue positions and required check names through read-only requests', () => {
    const calls: string[][] = [];
    const rows = collectMergeEtas('.', 'ashlrai/phantom', history, args => {
      calls.push(args);
      return args[0] === 'api' ? { data: { repository: { pullRequests: { nodes: [
        { number: 42, mergeQueueEntry: { position: 3 } }, { number: 43, mergeQueueEntry: null },
      ] } } } } : [{ name: 'build', bucket: 'pass' }, { name: 'test', bucket: 'pending' }];
    });
    expect(rows).toEqual([
      { ...estimate(3), waitingOn: 'position', waitingMs: null, recut: null },
      { number: 43, queuePosition: null, rangeMinutes: null, waitingOn: null, waitingMs: null, recut: null },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('--required');
  });
  it('keeps unknown PR rows without history and avoids fetching checks', () => {
    let calls = 0;
    expect(collectMergeEtas('.', 'ashlrai/phantom', [], () => {
      calls++;
      return { data: { repository: { pullRequests: { nodes: [{ number: 1, mergeQueueEntry: { position: 1 } }] } } } };
    })).toEqual([{ number: 1, queuePosition: 1, rangeMinutes: null, waitingOn: 'checks', waitingMs: null, recut: null }]);
    expect(calls).toBe(1);
  });
  it('keeps a queued PR unknown when required checks cannot be read', () => {
    for (const checks of [null, [], [{ name: 17 }], [{ name: 'unobserved', bucket: 'pending' }], [{ name: 'test', bucket: 'fail' }]]) {
      const rows = collectMergeEtas('.', 'ashlrai/phantom', history, args => args[0] === 'api'
        ? { data: { repository: { pullRequests: { nodes: [{ number: 42, mergeQueueEntry: { position: 1 } }] } } } }
        : checks);
      expect(rows).toEqual([{ number: 42, queuePosition: 1, rangeMinutes: null, waitingOn: 'checks', waitingMs: null, recut: null }]);
    }
  });
  it('degrades on failed or malformed host reads without throwing', () => {
    for (const response of [null, {}, { data: { repository: null } }]) {
      expect(collectMergeEtas('.', 'ashlrai/phantom', history, () => response)).toEqual([]);
    }
    expect(collectMergeEtas('.', 'ashlrai/phantom', history, () => { throw Error('offline'); })).toEqual([]);
    expect(collectMergeEtas('.', '../bad', history, () => { throw Error('must not read'); })).toEqual([]);
  });
});

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const NOW = Date.parse('2026-10-31T12:00:00Z');
const queuedAt = (position: number, enqueuedAt = '2026-10-31T11:51:00Z') => ({
  position, enqueuedAt,
});
const node = (over: Record<string, unknown>) => ({
  number: 42, headRefOid: HEAD_A, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  mergeQueueEntry: queuedAt(1), ...over,
});
/** One fake repository read; `nodes` are the GraphQL PR rows, `checks` the required-check answer. */
const collect = (nodes: unknown[], checks: unknown = [{ name: 'build', bucket: 'pass' }, { name: 'test', bucket: 'pending' }]) => {
  const calls: string[][] = [];
  const rows = collectMergeEtas('.', 'ashlrai/phantom', history, args => {
    calls.push(args);
    return args[0] === 'api' ? { data: { repository: { pullRequests: { nodes } } } } : checks;
  }, () => NOW);
  return { rows, calls };
};

describe('merge-queue wait attribution', () => {
  it('orders the causes: conflict outranks position, position outranks checks', () => {
    expect(attributeMergeWait(true, 1)).toBe('conflict');
    expect(attributeMergeWait(true, 4)).toBe('conflict');
    expect(attributeMergeWait(true, null)).toBe('conflict');
    expect(attributeMergeWait(false, 4)).toBe('position');
    expect(attributeMergeWait(false, 2)).toBe('position');
    expect(attributeMergeWait(false, 1)).toBe('checks');
    expect(attributeMergeWait(false, null)).toBeNull();
  });

  it('attributes queue time to the entries ahead or to required checks at the head', () => {
    const { rows } = collect([
      node({ number: 10, mergeQueueEntry: queuedAt(3) }),
      node({ number: 11, mergeQueueEntry: queuedAt(1) }),
      node({ number: 12, mergeQueueEntry: null }),
    ]);
    expect(rows[0]).toMatchObject({ number: 10, waitingOn: 'position', waitingMs: 9 * 60_000 });
    expect(rows[1]).toMatchObject({ number: 11, waitingOn: 'checks', waitingMs: 9 * 60_000 });
    expect(rows[2]).toMatchObject({ number: 12, waitingOn: null, waitingMs: null });
  });

  it('reports a missing enqueuedAt as an unattributed duration, never a fabricated one', () => {
    const { rows } = collect([node({ mergeQueueEntry: { position: 2 } })]);
    expect(rows[0]).toMatchObject({ waitingOn: 'position', waitingMs: null });
  });

  it('formats the attributed wait on the status line', () => {
    const [row] = collect([node({ number: 42, mergeQueueEntry: queuedAt(3) })]).rows;
    expect(formatMergeEta(row)).toBe('PR #42: merge ETA 15–24 min (queue #3) — waiting 9m on queue position');
    const [head] = collect([node({ number: 9, mergeQueueEntry: queuedAt(1, '2026-10-31T11:59:40Z') })]).rows;
    expect(formatMergeEta(head)).toBe('PR #9: merge ETA 5–8 min (queue #1) — waiting 20s on checks');
    expect(formatMergeEta({ number: 9, queuePosition: null, rangeMinutes: null, waitingOn: null, waitingMs: null, recut: null }))
      .toBe('PR #9: merge ETA unknown');
    // Bare estimates keep the pre-attribution shape.
    expect(formatMergeEta(estimate(3))).toBe('PR #42: merge ETA 15–24 min (queue #3)');
  });
});

describe('conflicting PR recut request', () => {
  it('a conflicting PR triggers exactly one idempotent recut request', () => {
    const nodes = [
      node({ number: 42, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', mergeQueueEntry: queuedAt(1) }),
      // A duplicate observation of the same conflicting head (e.g. a repage) is the same request.
      node({ number: 42, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', mergeQueueEntry: queuedAt(1) }),
      // A moved head is a genuinely new cut: it gets its own key.
      node({ number: 43, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', mergeQueueEntry: null, headRefOid: HEAD_B }),
    ];
    const { rows } = collect(nodes);
    expect(rows[0]).toMatchObject({
      waitingOn: 'conflict', waitingMs: 9 * 60_000,
      recut: { key: 'RQ-RECUT-phantom-42-aaaaaaa', repo: 'ashlrai/phantom', number: 42, headSha: HEAD_A },
    });
    expect(rows[1]).toMatchObject({ waitingOn: 'conflict', recut: null });
    expect(rows[2]).toMatchObject({
      waitingOn: 'conflict', waitingMs: null,
      recut: { key: 'RQ-RECUT-phantom-43-bbbbbbb', repo: 'ashlrai/phantom', number: 43, headSha: HEAD_B },
    });
    // Re-collecting the same conflicting heads yields the identical keys.
    expect(collect(nodes).rows.map(r => r.recut?.key ?? null))
      .toEqual(rows.map(r => r.recut?.key ?? null));
  });

  it('reads mergeable CONFLICTING or mergeStateStatus DIRTY as a conflict and never fetches its checks', () => {
    for (const over of [
      { mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' },
      { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' },
    ]) {
      const { rows, calls } = collect([node(over)]);
      expect(rows[0]!.waitingOn).toBe('conflict');
      expect(rows[0]!.recut?.key).toBe('RQ-RECUT-phantom-42-aaaaaaa');
      expect(calls.filter(a => a[0] === 'pr' && a[1] === 'checks')).toHaveLength(0);
    }
  });

  it('requests no recut when the head is untrusted, but still attributes the conflict', () => {
    for (const headRefOid of [undefined, null, 17, 'zzz', 'a'.repeat(41)]) {
      const { rows } = collect([node({ headRefOid, mergeable: 'CONFLICTING' })]);
      expect(rows[0]).toMatchObject({ waitingOn: 'conflict', recut: null });
    }
    expect(recutRequest('ashlrai/phantom', 42, null)).toBeNull();
    expect(recutRequest('ashlrai/phantom', 0, HEAD_A)).toBeNull();
    expect(recutRequest('ashlrai/phantom', 42, HEAD_A)?.key).toBe('RQ-RECUT-phantom-42-aaaaaaa');
  });

  it('formats the conflicted row with its recut request', () => {
    const [row] = collect([node({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })]).rows;
    expect(formatMergeEta(row))
      .toBe('PR #42: merge ETA unknown (queue #1) — waiting 9m on a merge conflict; recut RQ-RECUT-phantom-42-aaaaaaa requested');
    const [unkeyed] = collect([node({ headRefOid: null, mergeable: 'CONFLICTING' })]).rows;
    expect(formatMergeEta(unkeyed))
      .toBe('PR #42: merge ETA unknown (queue #1) — waiting 9m on a merge conflict');
  });
});
