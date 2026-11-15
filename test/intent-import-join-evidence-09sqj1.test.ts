import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import { emptyLedger, MAX_EVIDENCE, MAX_PRS, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-10-01T00:00:00.000Z';
const now = '2026-10-02T00:00:00.000Z';
let root: string;

function item(id: string, rq: string): IntentItem {
  return {
    id, title: `Directive ${id}`, source: id, owner: 'owner', rq: [rq], prs: [], status: 'queued',
    evidence: [], provenance: [{ source: id, date: at, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 604800000, createdAt: at, updatedAt: at,
  };
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'intent-join-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function bridge(first: IntentItem, second: IntentItem, other: IntentItem): Promise<string> {
  const ledger = emptyLedger();
  ledger.items.push(first, second, other);
  await writeLedger(ledger, root);
  const file = join(root, 'bridge.json');
  await writeFile(file, JSON.stringify({ title: 'Bridge', source: 'bridge', date: at, rq: ['RQ-FIRST-1', 'RQ-SECOND-1'] }));
  await importIntentFiles([file], { root, now });
  return file;
}

describe('joining existing intent evidence', () => {
  it('retains evidence, provenance and merged PR facts across persisted, repeated imports', async () => {
    const first = item('first', 'RQ-FIRST-1');
    const second = item('second', 'RQ-SECOND-1');
    const other = item('other', 'RQ-OTHER-1');
    const verification = { at, kind: 'verification' as const, ref: 'check-one', note: 'passed locally' };
    const release = { at: now, kind: 'release' as const, ref: 'v1.2.3', note: 'release record' };
    first.evidence = [verification];
    second.evidence = [verification, release];
    first.prs = [{ repo: 'Example/Project', number: 12, state: 'open' }];
    second.prs = [{ repo: 'example/project', number: 12, state: 'merged', url: 'https://example.test/user' }];
    const file = await bridge(first, second, other);
    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items[1]).toEqual(other);
    expect(ledger.items[0]).toMatchObject({
      id: 'first', rq: ['RQ-FIRST-1', 'RQ-SECOND-1'], evidence: [verification, release],
      prs: [{ repo: 'Example/Project', number: 12, state: 'merged', url: 'https://example.test/user' }],
      status: 'queued',
    });
    expect(ledger.items[0]!.provenance.map((row) => row.source)).toEqual(['first', 'bridge', 'second']);
    const persisted = await readFile(intentLedgerPath(root), 'utf8');
    await importIntentFiles([file], { root, now: '2026-10-03T00:00:00.000Z' });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(persisted);
  });

  it('deduplicates evidence and bounds rolling evidence and unique PRs without blocking upgrades', async () => {
    const first = item('first', 'RQ-FIRST-1');
    const second = item('second', 'RQ-SECOND-1');
    const other = item('other', 'RQ-OTHER-1');
    first.evidence = Array.from({ length: MAX_EVIDENCE }, (_, i) => ({ at, kind: 'note', ref: `e-${i}` }));
    second.evidence = [first.evidence[31]!, { at: now, kind: 'verification', ref: 'new', note: 'kept' }];
    first.prs = Array.from({ length: MAX_PRS }, (_, i) => ({ repo: 'example/project', number: i + 1, state: 'open' }));
    second.prs = [
      { repo: 'example/project', number: 99, state: 'open' },
      { repo: 'EXAMPLE/project', number: 1, state: 'merged', url: 'https://example.test/user' },
    ];
    await bridge(first, second, other);
    const joined = (await readLedger(root)).items[0]!;
    expect(joined.evidence).toHaveLength(MAX_EVIDENCE);
    expect(joined.evidence).toEqual([...first.evidence.slice(1), second.evidence[1]]);
    expect(joined.prs).toHaveLength(MAX_PRS);
    expect(joined.prs[0]).toMatchObject({ state: 'merged', url: 'https://example.test/user' });
    expect(joined.prs.some((pull) => pull.number === 99)).toBe(false);
  });
});
