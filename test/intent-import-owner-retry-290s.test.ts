import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool } from '../src/core/mcp-native.js';
import { intentLedgerPath, readLedger } from '../src/core/intent/store.js';

// Qualifies PR #5321 (RQ-PHX-INTENTIMPORTMCPRESTORE233S) through the native
// retry path: a failed multi-file import must leave the ledger byte-identical,
// the repaired retry must succeed exactly once, an equivalent repeat must
// dedupe without rewriting bytes, and an invalid-args call interleaved after
// success must not touch the recorded result. Same config/audit seam isolation
// as the owner suite; the importer, store and callNativeTool stay real.
vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/config.js')>()),
  loadConfig: () => ({}),
}));
vi.mock('../src/core/sandbox/audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/sandbox/audit.js')>()),
  audit: vi.fn(),
}));

const name = 'intent_import';
const STAMP = '2026-02-01T00:00:00.000Z';
let root: string;
let seed: string;
let good: string;
let second: string;

function ledgerBytes(): Buffer {
  return readFileSync(intentLedgerPath());
}

async function importPaths(paths: string[]) {
  return callNativeTool(name, { paths });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-intent-retry-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  seed = join(root, 'seed.jsonl');
  good = join(root, 'good.jsonl');
  second = join(root, 'second.jsonl');
  writeFileSync(seed, JSON.stringify({ title: 'Unrelated directive', source: 'seed source', date: STAMP }) + '\n');
  writeFileSync(good, [
    JSON.stringify({ title: 'Retry directive', rq: 'RQ-RETRY-290S', source: 'first file', date: STAMP }),
    JSON.stringify({ title: 'Second retry directive', source: 'first file', date: STAMP }),
  ].join('\n') + '\n');
  writeFileSync(second, JSON.stringify({ title: 'Cross-source duplicate', rq: 'RQ-RETRY-290S', source: 'second file', date: STAMP }) + '\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('native intent import retry', () => {
  it('keeps the ledger intact across a failed batch, a repaired retry, deduped repeats and invalid args', async () => {
    // Pre-existing ledger holding one unrelated directive.
    const seeded = await importPaths([seed]);
    expect(seeded.isError).toBeUndefined();
    expect(JSON.parse(seeded.content[0].text)).toEqual({ ok: true, schema: 'ashlr.intent-ledger/v1', imported: 1, deduped: 0, items: 1 });
    const seededBytes = ledgerBytes();

    // A malformed second file fails the whole batch before the ledger lock;
    // the valid first file must not be half-imported.
    writeFileSync(second, '{invalid json');
    const failed = await importPaths([good, second]);
    expect(failed.isError).toBe(true);
    expect(ledgerBytes()).toEqual(seededBytes);

    // Repair the second file and retry the same request: it succeeds once,
    // absorbing the cross-source duplicate into the first file's directive.
    writeFileSync(second, JSON.stringify({ title: 'Cross-source duplicate', rq: 'RQ-RETRY-290S', source: 'second file', date: STAMP }) + '\n');
    const retried = await importPaths([good, second]);
    expect(retried.isError).toBeUndefined();
    expect(JSON.parse(retried.content[0].text)).toEqual({ ok: true, schema: 'ashlr.intent-ledger/v1', imported: 2, deduped: 1, items: 3 });
    const importedBytes = ledgerBytes();
    const importedLedger = await readLedger();
    expect(importedLedger.items).toHaveLength(3);
    expect(importedLedger.items.find((item) => item.title === 'Unrelated directive')?.source).toBe('seed source');
    const tracked = importedLedger.items.find((item) => item.rq.includes('RQ-RETRY-290S'));
    expect(tracked?.provenance.map((row) => row.source)).toEqual(['first file', 'second file']);

    // An invalid-args request after success is refused before the handler and
    // cannot rewrite the recorded result.
    const invalid = await callNativeTool(name, { paths: [good], extra: true });
    expect(invalid.isError).toBe(true);
    expect(ledgerBytes()).toEqual(importedBytes);

    // Repeating the equivalent request dedupes every incoming row: counts
    // report zero new imports, item IDs and provenance stay stable, and the
    // ledger bytes are unchanged.
    const repeated = await importPaths([good, second]);
    expect(repeated.isError).toBeUndefined();
    expect(JSON.parse(repeated.content[0].text)).toEqual({ ok: true, schema: 'ashlr.intent-ledger/v1', imported: 0, deduped: 3, items: 3 });
    expect(ledgerBytes()).toEqual(importedBytes);
    const repeatedLedger = await readLedger();
    expect(repeatedLedger.items.map((item) => item.id)).toEqual(importedLedger.items.map((item) => item.id));
    expect(repeatedLedger.items.map((item) => item.provenance)).toEqual(importedLedger.items.map((item) => item.provenance));
    expect(repeatedLedger.items.some((item) => item.title === 'Unrelated directive')).toBe(true);
  });
});
