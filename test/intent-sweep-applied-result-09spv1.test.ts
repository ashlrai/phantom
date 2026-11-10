import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { sweepStale } from '../src/core/intent/sweep.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const old = '2026-11-01T00:00:00Z';
const now = '2026-11-09T00:00:00Z';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function item(id: string, status: IntentStatus, extra: Partial<IntentItem> = {}): IntentItem {
  return { id, title: `Directive ${id}`, source: 'fake note', owner: 'owner', rq: ['RQ-FAKE-1'], prs: [], status,
    evidence: [{ at: old, kind: 'note', ref: 'original evidence' }], provenance: [], partial: false,
    closureProposal: null, lastTouchedAt: old, staleAfterMs: 60_000, createdAt: old, updatedAt: old, ...extra };
}
async function seed(items: IntentItem[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'intent-sweep-result-')); roots.push(root);
  await writeLedger({ ...emptyLedger(), items }, root);
  return root;
}

it('requeues stale proposed, unknown and in-progress items and reports the persisted status', async () => {
  const root = await seed([item('proposed', 'proposed'), item('unknown', 'unknown'), item('active', 'in-progress')]);
  const path = intentLedgerPath(root);
  const before = await readFile(path, 'utf8');
  const preview = await sweepStale({ root, now });
  expect(preview).toMatchObject({ applied: false, updated: 0 });
  expect(preview.stale.map(row => [row.id, row.status, row.action])).toEqual([
    ['proposed', 'proposed', 'requeue'], ['unknown', 'unknown', 'requeue'], ['active', 'in-progress', 'requeue']]);
  expect(await readFile(path, 'utf8')).toBe(before);

  const applied = await sweepStale({ root, now, apply: true });
  expect(applied).toMatchObject({ applied: true, updated: 3 });
  const ledger = await readLedger(root);
  expect(applied.stale.map(row => row.status)).toEqual(ledger.items.map(entry => entry.status));
  for (const entry of ledger.items) {
    expect(entry).toMatchObject({ status: 'queued', lastTouchedAt: now, updatedAt: now, closureProposal: null });
    expect(entry.evidence).toMatchObject([{ ref: 'original evidence' }, { kind: 'sweep', ref: 'requeue' }]);
  }
});

it('leaves fresh, terminal and merged items alone', async () => {
  const items = [item('fresh', 'proposed', { lastTouchedAt: now }), item('merged', 'merged'),
    ...(['shipped', 'verified', 'closed', 'superseded'] as const).map(status => item(status, status))];
  const root = await seed(items);
  const applied = await sweepStale({ root, now, apply: true });
  expect(applied.stale).toMatchObject([{ id: 'merged', status: 'merged', action: 'await-verification' }]);
  const ledger = await readLedger(root);
  expect(ledger.items[0]).toEqual(items[0]);
  expect(ledger.items[1]).toMatchObject({ status: 'merged', evidence: [{ ref: 'original evidence' }, { ref: 'await-verification' }] });
  expect(ledger.items.slice(2)).toEqual(items.slice(2));
});

it('only recommends supersession and never closes items across repeated sweeps', async () => {
  const root = await seed([item('orphan', 'proposed', { rq: [] }), item('marked', 'queued', { closureProposal: 'superseded' })]);
  for (const time of ['2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z', '2026-11-11T00:00:00Z']) {
    const result = await sweepStale({ root, now: time, apply: true });
    expect(result.stale.map(row => [row.status, row.action])).toEqual([['proposed', 'propose-superseded'], ['queued', 'propose-superseded']]);
    expect((await readLedger(root)).items.map(entry => entry.status)).toEqual(['proposed', 'queued']);
  }
  const ledger = await readLedger(root);
  expect(ledger.items.map(entry => entry.closureProposal)).toEqual([null, 'superseded']);
  expect(ledger.items[0]?.evidence.at(-1)).toMatchObject({ kind: 'sweep', ref: 'propose-superseded' });
});

it('rejects invalid times without touching the ledger', async () => {
  const root = await seed([item('proposed', 'proposed')]);
  const before = await readFile(intentLedgerPath(root), 'utf8');
  await expect(sweepStale({ root, now: 'bad', apply: true })).rejects.toThrow('ISO timestamp');
  expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
});
