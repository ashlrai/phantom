import { describe, expect, it } from 'vitest';
import {
  EvidenceError,
  MAX_EVIDENCE,
  MAX_PRS,
  carriedKeys,
  linkMergedPull,
  markShipped,
  type EvidenceItem,
  type EvidenceLedger,
} from '../src/core/intent/evidence.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

type Fake = EvidenceItem & { id: string; title: string };

function fake(id: string, rq: string[], status: EvidenceItem['status'] = 'queued'): Fake {
  return { id, title: `Directive ${id}`, rq, prs: [], status, evidence: [], lastTouchedAt: T0, updatedAt: T0 };
}

function ledger(...items: Fake[]): EvidenceLedger<Fake> {
  return { items };
}

const pull = { repo: 'example/widgets', number: 7, title: 'unrelated', url: 'https://example.test/pull/7' };

describe('carriedKeys', () => {
  it('finds keys on boundaries and rejects embedded near-matches', () => {
    const known = ['RQ-EXAMPLE-1'];
    // The scan also yields the full suffixed token, as in the source.
    expect(carriedKeys('cursor/RQ-EXAMPLE-1-fix', known)).toContain('RQ-EXAMPLE-1');
    expect(carriedKeys('rq-example-1', known)).toEqual(['RQ-EXAMPLE-1']);
    expect(carriedKeys('XRQ-EXAMPLE-1', known)).toEqual([]);
    expect(carriedKeys('RQ-EXAMPLE-12', known)).not.toContain('RQ-EXAMPLE-1');
  });
});

describe('linkMergedPull', () => {
  it('matches RQ keys in branch or title, moves to merged only, and leaves others alone', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    const b = fake('b', ['RQ-OTHER-2']);
    const c = fake('c', ['RQ-EXAMPLE-12']);
    const l = ledger(a, b, c);
    const matched = linkMergedPull(l, { ...pull, branch: 'cursor/RQ-EXAMPLE-1-fix' }, T1);
    expect(matched).toEqual([a]);
    expect(a.status).toBe('merged');
    expect(a.prs).toEqual([{ repo: 'example/widgets', number: 7, state: 'merged', url: pull.url }]);
    expect(a.evidence).toEqual([{ at: T1, kind: 'pr', ref: 'example/widgets#7' }]);
    expect(a.updatedAt).toBe(T1);
    expect(a.id).toBe('a');
    expect(b).toEqual(fake('b', ['RQ-OTHER-2']));
    expect(c).toEqual(fake('c', ['RQ-EXAMPLE-12']));
  });

  it('matches title keys and multiple directives', () => {
    const a = fake('a', ['RQ-ONE-1']);
    const b = fake('b', ['RQ-TWO-2'], 'in-progress');
    expect(linkMergedPull(ledger(a, b), { ...pull, title: 'Land RQ-ONE-1 and RQ-TWO-2' }, T1)).toHaveLength(2);
    expect(a.status).toBe('merged');
    expect(b.status).toBe('merged');
  });

  it('rejects embedded alphanumeric near-matches', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    expect(linkMergedPull(ledger(a), { ...pull, title: 'fixRQ-EXAMPLE-1', branch: 'RQ-EXAMPLE-1X' }, T1)).toEqual([]);
    expect(a).toEqual(fake('a', ['RQ-EXAMPLE-1']));
  });

  it('dedupes a repeated pull association and case-folds the repo', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    const l = ledger(a);
    linkMergedPull(l, { ...pull, title: 'RQ-EXAMPLE-1', url: undefined }, T1);
    linkMergedPull(l, { ...pull, repo: 'Example/Widgets', title: 'RQ-EXAMPLE-1' }, T1);
    expect(a.prs).toHaveLength(1);
    expect(a.prs[0]).toMatchObject({ state: 'merged', url: pull.url });
    expect(a.evidence).toHaveLength(2);
  });

  it('bounds pulls and evidence', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    for (let n = 1; n <= MAX_EVIDENCE + 5; n += 1) {
      linkMergedPull(ledger(a), { ...pull, number: n, title: 'RQ-EXAMPLE-1' }, T1);
    }
    expect(a.prs).toHaveLength(MAX_PRS);
    expect(a.evidence).toHaveLength(MAX_EVIDENCE);
    expect(a.evidence.at(-1)?.ref).toBe(`example/widgets#${MAX_EVIDENCE + 5}`);
  });

  it('keeps terminal statuses; merged never implies shipped or verified', () => {
    const rows = (['shipped', 'verified', 'closed', 'superseded'] as const).map((s) => fake(s, ['RQ-EXAMPLE-1'], s));
    linkMergedPull(ledger(...rows), { ...pull, title: 'RQ-EXAMPLE-1' }, T1);
    expect(rows.map((r) => r.status)).toEqual(['shipped', 'verified', 'closed', 'superseded']);
    const open = fake('o', ['RQ-EXAMPLE-1']);
    linkMergedPull(ledger(open), { ...pull, title: 'RQ-EXAMPLE-1' }, T1);
    expect(open.status).toBe('merged');
  });

  it('uses pull.at as the clock when no override is given', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    linkMergedPull(ledger(a), { ...pull, title: 'RQ-EXAMPLE-1', at: T1 });
    expect(a.lastTouchedAt).toBe(T1);
  });

  it('rejects malformed input without mutating anything', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    const l = ledger(a);
    const bad = [
      { ...pull, title: 'RQ-EXAMPLE-1', repo: 'no-slash' },
      { ...pull, title: 'RQ-EXAMPLE-1', number: 0 },
      { ...pull, title: 'RQ-EXAMPLE-1', number: 1.5 },
      { ...pull, title: 'RQ-EXAMPLE-1', number: Number.NaN },
    ];
    for (const p of bad) expect(() => linkMergedPull(l, p, T1)).toThrow(EvidenceError);
    expect(() => linkMergedPull(l, { ...pull, title: 'RQ-EXAMPLE-1' }, 'not-a-time')).toThrow(EvidenceError);
    expect(() => linkMergedPull(l, { ...pull, title: 'RQ-EXAMPLE-1' })).toThrow(EvidenceError);
    expect(a).toEqual(fake('a', ['RQ-EXAMPLE-1']));
  });
});

describe('markShipped', () => {
  it('advances explicitly matched directives from queued or merged to shipped', () => {
    const queued = fake('q', ['RQ-ONE-1']);
    const merged = fake('m', ['RQ-TWO-2'], 'merged');
    const other = fake('x', ['RQ-NOT-3'], 'merged');
    const matched = markShipped(ledger(queued, merged, other), { release: 'v1.2.3', rq: ['rq-one-1'], notes: 'Includes RQ-TWO-2.' }, T1);
    expect(matched).toEqual([queued, merged]);
    expect(queued.status).toBe('shipped');
    expect(merged.status).toBe('shipped');
    expect(merged.evidence).toEqual([{ at: T1, kind: 'release', ref: 'v1.2.3' }]);
    expect(other).toEqual(fake('x', ['RQ-NOT-3'], 'merged'));
  });

  it('does not advance anything when the release names no directive', () => {
    const a = fake('a', ['RQ-EXAMPLE-1'], 'merged');
    expect(markShipped(ledger(a), { release: 'v2', notes: 'fixes everything, XRQ-EXAMPLE-1' }, T1)).toEqual([]);
    expect(a).toEqual(fake('a', ['RQ-EXAMPLE-1'], 'merged'));
  });

  it('never downgrades or sets verified; terminal items only gain evidence', () => {
    const verified = fake('v', ['RQ-EXAMPLE-1'], 'verified');
    const closed = fake('c', ['RQ-EXAMPLE-1'], 'closed');
    markShipped(ledger(verified, closed), { release: 'v3', rq: ['RQ-EXAMPLE-1'] }, T1);
    expect(verified.status).toBe('verified');
    expect(closed.status).toBe('closed');
    expect(verified.evidence).toHaveLength(1);
  });

  it('separates merged, shipped and verified across the full flow', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    const l = ledger(a);
    linkMergedPull(l, { ...pull, title: 'RQ-EXAMPLE-1' }, T0);
    expect(a.status).toBe('merged');
    markShipped(l, { release: 'v1', rq: ['RQ-EXAMPLE-1'] }, T1);
    expect(a.status).toBe('shipped');
    expect(a.status).not.toBe('verified');
  });

  it('rejects a bad release or time without mutation', () => {
    const a = fake('a', ['RQ-EXAMPLE-1']);
    const l = ledger(a);
    expect(() => markShipped(l, { release: '  ', rq: ['RQ-EXAMPLE-1'] }, T1)).toThrow(EvidenceError);
    expect(() => markShipped(l, { release: 'x'.repeat(201), rq: ['RQ-EXAMPLE-1'] }, T1)).toThrow(EvidenceError);
    expect(() => markShipped(l, { release: 'v1', rq: ['RQ-EXAMPLE-1'] }, 'nope')).toThrow(EvidenceError);
    expect(a).toEqual(fake('a', ['RQ-EXAMPLE-1']));
  });
});
