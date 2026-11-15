import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteShippedRelease } from '../src/core/intent/release.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { readLedger, writeLedger } from '../src/core/intent/store.js';

const initial = '2026-01-01T00:00:00.000Z';
const first = '2026-01-02T00:00:00.000Z';
const second = '2026-01-03T00:00:00.000Z';
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

function item(id: string, status: IntentItem['status'], rq: string[], number: number): IntentItem {
  return {
    id, title: id, source: 'fake source', owner: 'fake owner', rq,
    prs: [{ repo: 'example/project', number, state: 'merged' }], status,
    evidence: [{ at: initial, kind: 'note', ref: 'earlier history' }],
    provenance: [{ source: 'fake archive', date: initial, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: initial, staleAfterMs: 1000,
    createdAt: initial, updatedAt: initial,
  };
}

it('replays release notes once per matching directive while preserving persisted history', async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-replay-'));
  const items = [
    item('work', 'merged', ['RQ-WORK-1', 'RQ-SHARED-1'], 7),
    item('verified', 'verified', ['RQ-SHARED-1'], 7),
    item('closed', 'closed', ['RQ-CLOSED-1'], 8),
    item('pr-only', 'queued', ['RQ-OTHER-1'], 7),
  ];
  await writeLedger({ ...emptyLedger(), items }, root);
  const before = await readLedger(root);
  const release = { release: ' fake-v1 ', rq: ['RQ-WORK-1', 'RQ-SHARED-1', 'RQ-WORK-1'], notes: 'RQ-SHARED-1 RQ-CLOSED-1 example/project#7' };
  const expectedMatches = [
    { id: 'work', status: 'shipped' }, { id: 'verified', status: 'verified' }, { id: 'closed', status: 'closed' },
  ];
  for (const at of [first, second]) {
    expect(await noteShippedRelease(release, { root, now: at })).toEqual({ updated: 3, matches: expectedMatches });
    const persisted = await readLedger(root);
    for (let index = 0; index < 3; index++) {
      const row = persisted.items[index]!;
      expect(row.status).toBe(expectedMatches[index]!.status);
      expect(row.evidence).toEqual([
        ...before.items[index]!.evidence,
        ...[first, second].filter((time) => time <= at).map((time) => ({ at: time, kind: 'release', ref: 'fake-v1' })),
      ]);
      expect(row.provenance).toEqual(before.items[index]!.provenance);
      expect(row.prs).toEqual(before.items[index]!.prs);
      expect(row.createdAt).toBe(initial);
      expect(row.lastTouchedAt).toBe(at);
      expect(row.updatedAt).toBe(at);
    }
    expect(persisted.items[3]).toEqual(before.items[3]);
  }
  expect(await noteShippedRelease({ release: 'fake-v1', notes: 'example/project#7' }, { root, now: second }))
    .toEqual({ updated: 0, matches: [] });
  const afterUnmatched = await readLedger(root);
  expect(afterUnmatched.items[0]!.evidence).toHaveLength(3);
  expect(afterUnmatched.items[3]).toEqual(before.items[3]);
});
