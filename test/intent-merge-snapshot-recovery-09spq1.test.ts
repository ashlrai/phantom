import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

it('persists healthy merge observations once and isolates private ledger failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-snapshot-'));
  try {
    const at = '2026-01-01T00:00:00.000Z';
    const item: IntentItem = { id: 'one', title: 'Synthetic directive', source: 'fixture', owner: 'fixture', rq: ['RQ-TEST-1'], prs: [], status: 'queued', evidence: [], provenance: [{ source: 'fixture', date: at, verbatim: true, partial: false }], partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at };
    const ledger = emptyLedger(); ledger.items.push(item);
    await writeLedger(ledger, root);
    let clock = Date.parse(at);
    let source: unknown = { count: 1, items: [{ repo: 'fake/repo', number: 1, title: 'RQ-TEST-1 synthetic' }] };
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
    expect(first.status).toBe('merged');
    expect(first.prs).toEqual([{ repo: 'fake/repo', number: 1, state: 'merged' }]);
    expect(first.provenance).toEqual(item.provenance);
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    clock += 3000; await snapshot();
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
    source = { count: 1, items: [{ repo: 'fake/repo', number: 2, title: 'RQ-TEST-1 synthetic' }] };
    clock += 3000; await snapshot();
    expect((await readLedger(root)).items[0]!.prs).toHaveLength(2);
    const second = await readFile(intentLedgerPath(root), 'utf8');
    source = { sourceState: 'degraded', count: 1, items: [{ repo: 'fake/repo', number: 3, title: 'RQ-TEST-1 synthetic' }] };
    clock += 3000; await snapshot();
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(second);
    await writeFile(intentLedgerPath(root), 'private corrupt fixture');
    source = { count: 1, items: [{ repo: 'fake/repo', number: 3, title: 'RQ-TEST-1 synthetic' }] };
    clock += 3000; expect(await snapshot()).not.toContain('private corrupt fixture');
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe('private corrupt fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
});
