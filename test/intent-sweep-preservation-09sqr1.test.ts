import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';
import { sweepStale } from '../src/core/intent/sweep.js';

const start = '2026-11-01T00:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(start) + ms).toISOString();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function item(id: string, status: IntentStatus, extra: Partial<IntentItem> = {}): IntentItem {
  return { id, title: `Directive ${id}`, source: `fake source ${id}`, owner: 'owner', rq: [], prs: [], status,
    evidence: [{ at: start, kind: 'note', ref: `origin ${id}` }],
    provenance: [{ source: `fake source ${id}`, date: start, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: start, staleAfterMs: 1000, createdAt: start, updatedAt: start, ...extra };
}

it('preserves directive evidence across threshold, preview and repeated stale intervals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-preservation-')); roots.push(root);
  const cases: Array<{ item: IntentItem; first: 'requeue' | 'propose-superseded' | 'await-verification'; second: 'propose-superseded' | 'await-verification' }> = [];
  for (const status of ['proposed', 'queued', 'unknown'] as const) {
    cases.push({ item: item(`${status}-rq`, status, { rq: ['RQ-FAKE-1'] }), first: 'requeue', second: 'propose-superseded' });
    cases.push({ item: item(`${status}-pull`, status, { prs: [{ repo: 'fake/repo', number: 7, state: 'open' }] }), first: 'requeue', second: 'propose-superseded' });
    cases.push({ item: item(`${status}-bare`, status), first: 'propose-superseded', second: 'propose-superseded' });
  }
  cases.push(
    { item: item('active', 'in-progress'), first: 'requeue', second: 'propose-superseded' },
    { item: item('requeued', 'queued', { rq: ['RQ-OTHER-1'], evidence: [{ at: start, kind: 'sweep', ref: 'requeue' }] }), first: 'propose-superseded', second: 'propose-superseded' },
    { item: item('proposal', 'unknown', { rq: ['RQ-OTHER-2'], closureProposal: 'superseded' }), first: 'propose-superseded', second: 'propose-superseded' },
    { item: item('merged', 'merged', { closureProposal: 'superseded', evidence: [{ at: start, kind: 'sweep', ref: 'requeue' }] }), first: 'await-verification', second: 'await-verification' },
  );
  const terminal = (['shipped', 'verified', 'closed', 'superseded'] as const).map(status => item(status, status));
  const fresh = item('unrelated-fresh', 'proposed', { lastTouchedAt: at(1000) });
  await writeLedger({ ...emptyLedger(), items: [...cases.map(row => row.item), ...terminal, fresh] }, root);
  const path = intentLedgerPath(root);
  const before = await readFile(path, 'utf8');
  expect((await sweepStale({ root, now: at(1000), apply: true })).updated).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(before);
  const preview = await sweepStale({ root, now: at(1001) });
  expect(preview.stale.map(row => [row.id, row.status, row.action])).toEqual(cases.map(row => [row.item.id, row.item.status, row.first]));
  expect(await readFile(path, 'utf8')).toBe(before);
  for (const [time, phase] of [[at(1001), 'first'], [at(2002), 'second']] as const) {
    const result = await sweepStale({ root, now: time, apply: true });
    const persisted = await readLedger(root);
    // The unrelated row becomes stale at the second interval; check it independently below.
    const rows = result.stale.filter(row => row.id !== fresh.id);
    expect(rows.map(row => [row.id, row.action, row.status])).toEqual(cases.map(({ item: original, first, second }) => [
      original.id, phase === 'first' ? first : second, first === 'requeue' ? 'queued' : original.status,
    ]));
    for (const { item: original, first } of cases) {
      const saved = persisted.items.find(row => row.id === original.id)!;
      expect(saved.status).toBe(first === 'requeue' ? 'queued' : original.status);
      expect(saved.provenance).toEqual(original.provenance);
      expect(saved.evidence.slice(0, original.evidence.length)).toEqual(original.evidence);
      expect(saved.evidence.slice(original.evidence.length)).toHaveLength(phase === 'first' ? 1 : 2);
      expect(saved.evidence.at(-1)).toMatchObject({ kind: 'sweep', note: 'Local stale tracking refreshed; no job dispatched.' });
      expect(saved.closureProposal).toBe(original.closureProposal);
      expect(saved.rq).toEqual(original.rq);
      expect(saved.prs).toEqual(original.prs);
    }
    expect(persisted.items.filter(row => terminal.some(original => original.id === row.id))).toEqual(terminal);
    if (phase === 'first') expect(persisted.items.find(row => row.id === fresh.id)).toEqual(fresh);
    else expect(persisted.items.find(row => row.id === fresh.id)).toMatchObject({ status: 'proposed', provenance: fresh.provenance, closureProposal: null });
  }
});
