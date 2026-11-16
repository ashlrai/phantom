import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';
import { noteMergeSnapshot } from '../src/core/intent/merge-snapshot.js';

const AT = '2026-02-02T00:00:00.000Z';

function item(id: string, status: IntentItem['status'], rq: string[] = ['RQ-TEST-7']): IntentItem {
  return {
    id, title: `Synthetic ${id}`, source: 'fixture', owner: 'fixture', rq, prs: [], status,
    evidence: [], provenance: [{ source: 'fixture', date: AT, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: AT, staleAfterMs: 1000, createdAt: AT, updatedAt: AT,
  };
}

it('advances only queued and in-progress items while still receipting evidence on held statuses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-snapshot-s151-'));
  try {
    const ledger = emptyLedger();
    ledger.items.push(item('queued-one', 'queued'), item('progress-one', 'in-progress'), item('held-one', 'proposed'));
    await writeLedger(ledger, root);
    const after = '2026-02-02T01:00:00.000Z';
    await noteMergeSnapshot([{ repo: 'fake/repo', number: 7, title: 'bridge: RQ-TEST-7 lands' }], root, after);
    const items = (await readLedger(root)).items;
    expect(items.map(i => i.status)).toEqual(['merged', 'merged', 'proposed']);
    for (const i of items) {
      expect(i.prs).toEqual([{ repo: 'fake/repo', number: 7, state: 'merged' }]);
      expect(i.evidence.some(row => row.kind === 'pr' && row.ref === 'fake/repo#7')).toBe(true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('replays a snapshot without rewriting an unchanged private ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-snapshot-s151-'));
  try {
    const ledger = emptyLedger();
    ledger.items.push(item('one', 'queued'));
    await writeLedger(ledger, root);
    const pull = { repo: 'fake/repo', number: 9, title: 'RQ-TEST-9 other key does not match; RQ-TEST-7 does' };
    await noteMergeSnapshot([pull], root, AT);
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    await noteMergeSnapshot([pull], root, AT);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
    const stored = await readLedger(root);
    expect(stored.items[0]!.prs).toHaveLength(1);
    expect(stored.items[0]!.evidence.filter(row => row.kind === 'pr' && row.ref === 'fake/repo#9')).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('skips malformed pull observations instead of throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-snapshot-s151-'));
  try {
    const ledger = emptyLedger();
    ledger.items.push(item('one', 'queued'));
    await writeLedger(ledger, root);
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    await noteMergeSnapshot([
      { repo: 'not a repo!', number: 5, title: 'RQ-TEST-7' },
      { repo: 'fake/repo', number: 0, title: 'RQ-TEST-7' },
      { repo: 'fake/repo', number: Number.MAX_SAFE_INTEGER + 1, title: 'RQ-TEST-7' },
    ], root, AT);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
