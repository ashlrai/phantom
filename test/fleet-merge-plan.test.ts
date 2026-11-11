import { expect, it } from 'vitest';
import { reworkEdges, supersededOpenPrs, type MergePlanPr } from '../src/core/fleet/merge-plan.js';

it('detects open-vs-open superseded duplicates from every evidence grammar', () => {
  const mk = (number: number, over: Partial<MergePlanPr> = {}): MergePlanPr => ({
    number, title: `bridge: X-${number}`, isDraft: false,
    state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false,
    checks: [], autoMerge: null, headSha: null, files: [], url: null,
    ...over,
  } as unknown as MergePlanPr);
  const prs = [
    mk(100),
    mk(101, { title: 'bridge: RQ-FIX-PHANTOM-100' }),
    mk(102, { title: 'bridge: RQ-REBASE-PHANTOM-100' }),
    mk(103, { title: 'bridge: RQ-RECUT-PHANTOM-101-abcdef1' }),
    mk(104, { body: 'Supersedes #102 and recut handoff: PR #103', hasBody: true }),
    mk(105, { body: 'superseded by #104', hasBody: true }),
    mk(106, { isDraft: true, title: 'bridge: RQ-FIX-PHANTOM-105' }),
    mk(107, { body: 'I fetched pull/999 and compared #998 — incidental mentions', hasBody: true }),
  ];
  const { edges, closedRefs } = reworkEdges(prs, 'ashlrai/phantom');
  expect(edges.map(e => `${e.reworker}->${e.origin}:${e.evidence}`).sort()).toEqual([
    '101->100:title-fix', '102->100:title-rebase', '103->101:title-recut',
    '104->102:body-supersedes', '104->103:body-handoff', '104->105:body-superseded-by',
  ].sort());
  expect(closedRefs).toBe(0);
  const { proposals, families } = supersededOpenPrs(prs, 'ashlrai/phantom');
  expect(families).toBe(1);
  const byNumber = new Map(proposals.map(p => [p.number, p]));
  expect([...byNumber.keys()].sort((a, b) => a - b)).toEqual([100, 101, 102, 103, 105]);
  expect(byNumber.get(100)).toMatchObject({ supersededBy: 104, kind: 'origin' });
  expect(byNumber.get(101)).toMatchObject({ supersededBy: 104, kind: 'stale-rework' });
  expect(byNumber.get(103)).toMatchObject({ supersededBy: 104, kind: 'stale-rework' });
  expect(byNumber.get(105)).toMatchObject({ supersededBy: 104 });
  expect(byNumber.get(100)!.reason).toContain('#104');
});

it('keeps closed-origin references out of proposals', () => {
  const mk = (number: number, over: Partial<MergePlanPr> = {}): MergePlanPr => ({
    number, title: `bridge: X-${number}`, isDraft: false, state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false,
    checks: [], autoMerge: null, headSha: null, files: [], url: null, ...over,
  } as unknown as MergePlanPr);
  const { closedRefs } = reworkEdges([mk(200, { title: 'bridge: RQ-FIX-PHANTOM-199' })], 'ashlrai/phantom');
  expect(closedRefs).toBe(1);
  expect(supersededOpenPrs([mk(200, { title: 'bridge: RQ-FIX-PHANTOM-199' })], 'ashlrai/phantom').proposals).toEqual([]);
});

