import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import { INTENT_LEDGER_SCHEMA, type IntentItem, type IntentLedger } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-10-01T00:00:00.000Z';
const now = '2026-10-02T00:00:00.000Z';
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'intent-native-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function nativeItem(id: string, rq: string, overrides: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Native directive ${id}`, source: `native-${id}`, owner: 'owner', rq: [rq],
    prs: [{ repo: 'example/project', number: 7, url: 'https://example.test/pr/7', state: 'merged' }],
    status: 'verified',
    evidence: [
      { at, kind: 'verification', ref: 'check-native', note: 'passed in fake run' },
      { at: now, kind: 'release', ref: 'v9.9.9', note: 'fake release record' },
    ],
    provenance: [
      { source: `native-${id}`, date: at, verbatim: true, partial: false },
      { source: 'second-copy', date: now, verbatim: false, partial: true },
    ],
    partial: true,
    closureProposal: 'superseded',
    lastTouchedAt: now,
    staleAfterMs: 12345678,
    createdAt: '2026-09-15T12:00:00.000Z',
    updatedAt: '2026-09-20T08:30:00.000Z',
    ...overrides,
  };
}

function nativeLedger(items: IntentItem[]): IntentLedger {
  return { schema: INTENT_LEDGER_SCHEMA, items };
}

async function writeNative(name: string, ledger: unknown): Promise<string> {
  const file = join(root, name);
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
}

describe('native intent-ledger import', () => {
  it('roundtrips a schema-tagged ledger into an empty root with every field intact', async () => {
    const items = [nativeItem('keep-one', 'RQ-KEEP-1'), nativeItem('keep-two', 'RQ-KEEP-2', { partial: false, closureProposal: null })];
    const file = await writeNative('ledger-copy.json', nativeLedger(items));
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 2, deduped: 0, items: 2 });
    const ledger = await readLedger(root);
    expect(ledger.schema).toBe(INTENT_LEDGER_SCHEMA);
    expect(ledger.items).toEqual(items);
  });

  it('merges a native item into a matching directive without losing evidence or lowering status', async () => {
    const existing = nativeItem('local', 'RQ-SHARED-1', {
      status: 'verified',
      evidence: [{ at, kind: 'verification', ref: 'check-native', note: 'passed in fake run' }],
      provenance: [{ source: 'local-directive', date: at, verbatim: true, partial: false }],
      prs: [],
      partial: false,
      closureProposal: null,
    });
    const incoming = nativeItem('incoming', 'RQ-SHARED-1', { status: 'merged' });
    await writeLedger(nativeLedger([existing]), root);
    const file = await writeNative('incoming-ledger.json', nativeLedger([incoming, nativeItem('fresh', 'RQ-FRESH-1')]));
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 1, deduped: 1, items: 2 });
    const ledger = await readLedger(root);
    const merged = ledger.items.find((item) => item.rq.includes('RQ-SHARED-1'))!;
    expect(merged.id).toBe('local');
    expect(merged.status).toBe('verified');
    expect(merged.evidence).toEqual(incoming.evidence);
    expect(merged.prs).toEqual(incoming.prs);
    expect(merged.partial).toBe(true);
    expect(merged.closureProposal).toBeNull();
    expect(merged.provenance.map((row) => row.source)).toEqual(['local-directive', 'native-incoming', 'second-copy']);
    expect(ledger.items.find((item) => item.rq.includes('RQ-FRESH-1'))).toMatchObject({ id: 'fresh', status: 'verified' });
  });

  it('is semantically idempotent across repeated native imports', async () => {
    const file = await writeNative('repeat.json', nativeLedger([nativeItem('again', 'RQ-AGAIN-1')]));
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 1, deduped: 0, items: 1 });
    const first = await readFile(intentLedgerPath(root), 'utf8');
    expect(await importIntentFiles([file], { root, now: '2026-10-03T00:00:00.000Z' })).toEqual({ imported: 0, deduped: 1, items: 1 });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(first);
  });

  it('fails atomically when a tagged ledger is invalid, even as a later file in the batch', async () => {
    const seed = nativeItem('seed', 'RQ-SEED-1', { status: 'queued', evidence: [], prs: [], provenance: [{ source: 'seed', date: at, verbatim: true, partial: false }] });
    await writeLedger(nativeLedger([seed]), root);
    const before = await readFile(intentLedgerPath(root), 'utf8');
    const valid = join(root, 'valid.jsonl');
    await writeFile(valid, `${JSON.stringify({ title: 'Plain row', rq: 'RQ-PLAIN-1', date: at })}\n`);
    const bad = await writeNative('bad-ledger.json', {
      schema: INTENT_LEDGER_SCHEMA,
      items: [{ ...nativeItem('bad', 'RQ-BAD-1'), status: 'not-a-status' }],
    });
    await expect(importIntentFiles([valid, bad], { root, now })).rejects.toThrow(/not a valid ledger/);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
    expect((await readLedger(root)).items).toHaveLength(1);
  });

  it('keeps untagged JSON and JSONL imports on the row path', async () => {
    const file = join(root, 'rows.jsonl');
    await writeFile(file, [
      JSON.stringify({ title: 'Row one', rq: 'RQ-ROW-1', date: at, status: 'queued' }),
      JSON.stringify({ title: 'Row two', rq: 'RQ-ROW-2', date: at, status: 'done' }),
    ].join('\n'));
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 2, deduped: 0, items: 2 });
    const ledger = await readLedger(root);
    expect(ledger.items.map((item) => item.status)).toEqual(['queued', 'closed']);
    expect(ledger.items.every((item) => item.prs.length === 0 && item.evidence.length === 0)).toBe(true);
  });
});
