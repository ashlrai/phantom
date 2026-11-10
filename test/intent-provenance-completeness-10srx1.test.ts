import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import {
  INTENT_LEDGER_SCHEMA,
  MAX_PROVENANCE,
  type IntentItem,
  type IntentLedger,
  type IntentProvenance,
} from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger } from '../src/core/intent/store.js';

const at = '2026-10-01T00:00:00.000Z';
const now = '2026-10-02T00:00:00.000Z';
const later = '2026-10-03T00:00:00.000Z';
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'intent-prov-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function prov(source: string, partial: boolean, date: string | null = at): IntentProvenance {
  return { source, date, verbatim: true, partial };
}

function nativeItem(id: string, rq: string, provenance: IntentProvenance[], overrides: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Directive ${id}`, source: `src-${id}`, owner: 'owner', rq: [rq],
    prs: [], status: 'queued', evidence: [],
    provenance,
    partial: provenance.some((row) => row.partial),
    closureProposal: null, lastTouchedAt: at, staleAfterMs: 604800000,
    createdAt: at, updatedAt: at,
    ...overrides,
  };
}

function nativeLedger(items: IntentItem[]): IntentLedger {
  return { schema: INTENT_LEDGER_SCHEMA, items };
}

async function writeNative(dir: string, name: string, ledger: unknown): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
}

describe('intent provenance completeness on import', () => {
  it('a complete copy upgrades a partial provenance row without clearing the item flag or metadata', async () => {
    const partialFile = await writeNative(root, 'partial.json', nativeLedger([
      nativeItem('first', 'RQ-PROV-UPGRADE-1', [prov('copy-a', true)], {
        status: 'verified',
        closureProposal: 'superseded',
        rq: ['RQ-PROV-UPGRADE-1', 'RQ-PROV-UPGRADE-EXTRA'],
        prs: [{ repo: 'example/project', number: 7, url: 'https://example.test/pr/7', state: 'merged' }],
        evidence: [{ at, kind: 'verification', ref: 'check-one', note: 'passed' }],
      }),
    ]));
    expect(await importIntentFiles([partialFile], { root, now })).toEqual({ imported: 1, deduped: 0, items: 1 });

    const completeFile = await writeNative(root, 'complete.json', nativeLedger([
      nativeItem('second', 'RQ-PROV-UPGRADE-1', [prov('copy-a', false)], {
        status: 'merged',
        prs: [{ repo: 'example/project', number: 8, state: 'open' }],
        evidence: [{ at: now, kind: 'release', ref: 'v1.0.0' }],
      }),
    ]));
    expect(await importIntentFiles([completeFile], { root, now })).toEqual({ imported: 0, deduped: 1, items: 1 });

    const item = (await readLedger(root)).items[0]!;
    expect(item.id).toBe('first');
    expect(item.provenance).toEqual([prov('copy-a', false)]);
    // The aggregate stays conservative: a partial copy was observed, so the
    // item remains partial even though the surviving provenance row is complete.
    expect(item.partial).toBe(true);
    expect(item.status).toBe('verified');
    expect(item.closureProposal).toBe('superseded');
    expect(item.rq).toEqual(['RQ-PROV-UPGRADE-1', 'RQ-PROV-UPGRADE-EXTRA']);
    expect(item.prs.map((pull) => pull.number)).toEqual([7, 8]);
    expect(item.evidence.map((row) => row.ref)).toEqual(['check-one', 'v1.0.0']);

    const persisted = await readFile(intentLedgerPath(root), 'utf8');
    await importIntentFiles([partialFile, completeFile], { root, now: later });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(persisted);
  });

  it('a partial copy cannot downgrade a complete provenance row', async () => {
    const completeFile = await writeNative(root, 'complete.json', nativeLedger([
      nativeItem('whole', 'RQ-PROV-DOWNGRADE-1', [prov('copy-a', false)], { partial: false }),
    ]));
    expect(await importIntentFiles([completeFile], { root, now })).toEqual({ imported: 1, deduped: 0, items: 1 });

    const partialFile = await writeNative(root, 'partial.json', nativeLedger([
      nativeItem('frag', 'RQ-PROV-DOWNGRADE-1', [prov('copy-a', true)], { partial: true }),
    ]));
    expect(await importIntentFiles([partialFile], { root, now })).toEqual({ imported: 0, deduped: 1, items: 1 });

    const item = (await readLedger(root)).items[0]!;
    expect(item.provenance).toEqual([prov('copy-a', false)]);
    expect(item.partial).toBe(true);
  });

  it('stores identical provenance rows regardless of which copy imports first', async () => {
    const partialFirst = await mkdtemp(join(tmpdir(), 'intent-prov-a-'));
    const completeFirst = await mkdtemp(join(tmpdir(), 'intent-prov-b-'));
    try {
      const partialRows = [prov('copy-a', true), prov('copy-b', true)];
      const completeRows = [prov('copy-a', false), prov('copy-b', false)];
      const partialFile = await writeNative(partialFirst, 'partial.json', nativeLedger([
        nativeItem('frag', 'RQ-PROV-ORDER-1', partialRows, { partial: true }),
      ]));
      const completeFile = await writeNative(completeFirst, 'complete.json', nativeLedger([
        nativeItem('whole', 'RQ-PROV-ORDER-1', completeRows, { partial: false }),
      ]));
      await importIntentFiles([partialFile], { root: partialFirst, now });
      await importIntentFiles([completeFile], { root: partialFirst, now });
      await importIntentFiles([completeFile], { root: completeFirst, now });
      await importIntentFiles([partialFile], { root: completeFirst, now });

      const a = (await readLedger(partialFirst)).items[0]!;
      const b = (await readLedger(completeFirst)).items[0]!;
      expect(a.provenance).toEqual(completeRows);
      expect(b.provenance).toEqual(completeRows);
      expect(a.partial).toBe(true);
      expect(b.partial).toBe(true);
    } finally {
      await rm(partialFirst, { recursive: true, force: true });
      await rm(completeFirst, { recursive: true, force: true });
    }
  });

  it('keeps distinct provenance identities and stays partial while any source is partial', async () => {
    const firstFile = await writeNative(root, 'first.json', nativeLedger([
      nativeItem('multi', 'RQ-PROV-DISTINCT-1', [
        prov('copy-a', true),
        prov('copy-a', false, now),
        { source: 'copy-a', date: at, verbatim: false, partial: true },
        prov('copy-b', true),
      ], { partial: true }),
    ]));
    expect(await importIntentFiles([firstFile], { root, now })).toEqual({ imported: 1, deduped: 0, items: 1 });

    const secondFile = await writeNative(root, 'second.json', nativeLedger([
      nativeItem('upgrade', 'RQ-PROV-DISTINCT-1', [prov('copy-a', false)], { partial: false }),
    ]));
    expect(await importIntentFiles([secondFile], { root, now })).toEqual({ imported: 0, deduped: 1, items: 1 });

    const item = (await readLedger(root)).items[0]!;
    expect(item.provenance).toEqual([
      prov('copy-a', false),
      prov('copy-a', false, now),
      { source: 'copy-a', date: at, verbatim: false, partial: true },
      prov('copy-b', true),
    ]);
    expect(item.partial).toBe(true);
  });

  it('bounds merged provenance at MAX_PROVENANCE without losing the newest identities', async () => {
    const rowsA = Array.from({ length: 10 }, (_, i) => prov(`src-a${i + 1}`, false));
    const rowsB = Array.from({ length: 10 }, (_, i) => prov(`src-b${i + 1}`, false));
    const fileA = await writeNative(root, 'a.json', nativeLedger([
      nativeItem('cap-a', 'RQ-PROV-CAP-1', rowsA, { partial: false }),
    ]));
    const fileB = await writeNative(root, 'b.json', nativeLedger([
      nativeItem('cap-b', 'RQ-PROV-CAP-1', rowsB, { partial: false }),
    ]));
    await importIntentFiles([fileA], { root, now });
    await importIntentFiles([fileB], { root, now });

    const item = (await readLedger(root)).items[0]!;
    expect(item.provenance).toHaveLength(MAX_PROVENANCE);
    expect(item.provenance[0]!.source).toBe('src-a5');
    expect(item.provenance[MAX_PROVENANCE - 1]!.source).toBe('src-b10');
  });

  it('merges duplicate identities inside a single imported item', async () => {
    const file = await writeNative(root, 'dup.json', nativeLedger([
      nativeItem('dup', 'RQ-PROV-DUP-1', [prov('copy-a', true), prov('copy-a', false), prov('copy-b', true)], { partial: true }),
    ]));
    await importIntentFiles([file], { root, now });
    const item = (await readLedger(root)).items[0]!;
    expect(item.provenance).toEqual([prov('copy-a', false), prov('copy-b', true)]);
    expect(item.partial).toBe(true);
  });

  it('merges the same provenance identity on the raw JSONL row path', async () => {
    const partialFile = join(root, 'rows-partial.jsonl');
    await writeFile(partialFile, `${JSON.stringify({
      title: 'Raw directive…', source: 'raw-copy', date: at, rq: 'RQ-RAW-PROV-1', status: 'queued',
    })}\n`);
    const completeFile = join(root, 'rows-complete.jsonl');
    await writeFile(completeFile, `${JSON.stringify({
      title: 'Raw directive', source: 'raw-copy', date: at, rq: 'RQ-RAW-PROV-1', status: 'queued',
    })}\n`);

    await importIntentFiles([partialFile], { root, now });
    await importIntentFiles([completeFile], { root, now });

    const item = (await readLedger(root)).items[0]!;
    expect(item.provenance).toEqual([{ source: 'raw-copy', date: at, verbatim: false, partial: false }]);
    expect(item.partial).toBe(true);

    const persisted = await readFile(intentLedgerPath(root), 'utf8');
    await importIntentFiles([partialFile, completeFile], { root, now: later });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(persisted);
  });
});
