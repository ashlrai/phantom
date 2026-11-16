import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';
import { noteMergeSnapshot } from '../src/core/intent/merge-snapshot.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const at = '2026-01-01T00:00:00.000Z';
const item = (status: IntentItem['status'], rq: string[]): IntentItem => ({
  id: `id-${rq[0]}`, title: 'Synthetic directive', source: 'fixture', owner: 'fixture',
  rq, prs: [], status, evidence: [],
  provenance: [{ source: 'fixture', date: at, verbatim: true, partial: false }],
  partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000,
  createdAt: at, updatedAt: at,
});

it('keeps proposed status while recording the merge evidence through the snapshot route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-snapshot-recut-'));
  try {
    const ledger = emptyLedger(); ledger.items.push(item('proposed', ['RQ-RECUT-1']));
    await writeLedger(ledger, root);
    let clock = Date.parse(at);
    const source: unknown = { count: 1, items: [{ repo: 'fake/repo', number: 7, title: 'RQ-RECUT-1 lands the directive' }] };
    const fail = async () => { throw new Error('unavailable'); };
    const api = createFleetRunsApi({ runsDir: root, now: () => clock, readHostLoad: () => null, readRunsDir: fail, listWorkers: fail, readInbox: fail, readOutbox: fail, codexPersonal: fail, mergedLastHour: async () => source });
    async function snapshot() {
      let status = 0; let body = '';
      const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
      await api({} as VerseApiContext, Readable.from([]) as unknown as IncomingMessage, res, VERSE_FLEET_RUNS_PATH, 'GET');
      expect(status).toBe(200);
      return body;
    }
    await snapshot();
    const first = (await readLedger(root)).items[0]!;
    // Proposed is open-for-merge in evidence.ts but the snapshot caller only
    // advances queued and in-progress; evidence still lands as the durable receipt.
    expect(first.status).toBe('proposed');
    expect(first.prs).toEqual([{ repo: 'fake/repo', number: 7, state: 'merged' }]);
    expect(first.evidence).toEqual([{ at: expect.any(String), kind: 'pr', ref: 'fake/repo#7' }]);
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    clock += 3000; await snapshot();
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('skips invalid pulls and leaves the ledger untouched when nothing matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-snapshot-recut-'));
  try {
    const ledger = emptyLedger(); ledger.items.push(item('queued', ['RQ-OTHER-1']));
    await writeLedger(ledger, root);
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    await noteMergeSnapshot([
      { repo: 'no-slash', number: 5, title: 'RQ-OTHER-1 bad repo' },
      { repo: 'fake/repo', number: 0, title: 'RQ-OTHER-1 bad number' },
      { repo: 'fake/repo', number: 9, title: 'RQ-UNSEEN-9 names no known directive' },
    ], root, at);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
