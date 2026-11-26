import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isPlainRecord,
  nonEmptyTrimmedString,
  parseReadyQueueLine,
  pickLedgerString,
  QUEUE_LEDGER_EVENT_KEYS,
  QUEUE_LEDGER_JOB_KEYS,
  QUEUE_LEDGER_PHASE_KEYS,
  QUEUE_LEDGER_PR_KEYS,
  QUEUE_LEDGER_TS_KEYS,
} from '../src/core/queue/schema.js';
import { atomicWriteQueueFile, readQueueStream } from '../src/core/queue/store.js';
import { appendQueueVisits, compactQueueVisits, readQueueVisits, recordQueueVisit } from '../src/core/queue/journal.js';
import { replaceLockedQueueFile } from '../src/core/queue/order.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'queue-shared-helpers-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function* chunksOf(parts: readonly (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> {
  for (const part of parts) yield part;
}

describe('queue shared schema and dialect helpers', () => {
  it('detects plain non-array records', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('str')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);
  });

  it('extracts trimmed non-empty strings across canonical ledger key aliases', () => {
    expect(nonEmptyTrimmedString('  RQ-1  ')).toBe('RQ-1');
    expect(nonEmptyTrimmedString('   ')).toBeNull();
    expect(nonEmptyTrimmedString('')).toBeNull();
    expect(nonEmptyTrimmedString(123)).toBeNull();

    expect(pickLedgerString({ job: '  ', job_id: ' RQ-2 ', id: 'RQ-3' }, QUEUE_LEDGER_JOB_KEYS)).toBe('RQ-2');
    expect(pickLedgerString({ kind: 'launch' }, QUEUE_LEDGER_EVENT_KEYS)).toBe('launch');
    expect(pickLedgerString({ status: 'MERGED', phase: 'CLOSED' }, QUEUE_LEDGER_PHASE_KEYS)).toBe('MERGED');
    expect(pickLedgerString({ prUrl: ' https://github.com/ashlrai/phantom/pull/1 ' }, QUEUE_LEDGER_PR_KEYS))
      .toBe('https://github.com/ashlrai/phantom/pull/1');
    expect(pickLedgerString({ mergedAt: '2026-11-26T00:00:00Z' }, QUEUE_LEDGER_TS_KEYS))
      .toBe('2026-11-26T00:00:00Z');
    expect(pickLedgerString({}, QUEUE_LEDGER_JOB_KEYS)).toBeNull();
  });

  it('parses live router-queue READY lines and optional enq= unix seconds', () => {
    expect(parseReadyQueueLine('- READY RQ-TEST-1 (P1, enq=1700000000, repo=phantom): task'))
      .toEqual({ id: 'RQ-TEST-1', enqSeconds: 1700000000 });
    expect(parseReadyQueueLine('- READY RQ-TEST-2 (P2, repo=phantom): no enq token'))
      .toEqual({ id: 'RQ-TEST-2', enqSeconds: null });
    expect(parseReadyQueueLine('- READY RQ-TEST-3'))
      .toEqual({ id: 'RQ-TEST-3', enqSeconds: null });
    expect(parseReadyQueueLine('- CLAIMED 12:00 worker RQ-TEST-4 (enq=1700000000): claimed')).toBeNull();
    expect(parseReadyQueueLine('  - READY RQ-INDENTED (enq=1700000000): indented')).toBeNull();
  });

  it('keeps schema.ts and order-types.ts free of Node imports for web-UI consumers', () => {
    for (const rel of ['../src/core/queue/schema.ts', '../src/core/queue/order-types.ts']) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/from ['"]node:/);
    }
  });
});

describe('queue shared file and stream helpers', () => {
  it('atomically replaces files with the requested mode and leaves no temp sibling behind', async () => {
    const dir = tempDir();
    const target = join(dir, 'state.json');
    await atomicWriteQueueFile(target, '{"v":1}\n', 0o600);
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}\n');
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }

    await replaceLockedQueueFile(target, '{"v":2}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}\n');
  });

  it('preserves recordQueueVisit and appendQueueVisits parity and compacts atomically', async () => {
    const dir = tempDir();
    const journalPath = join(dir, 'visits.jsonl');
    const base = Date.UTC(2026, 10, 26, 12, 0, 0);
    await recordQueueVisit({ id: 'RQ-1:a1', station: 'READY', pool: 'claude', arrivedAt: base }, journalPath);
    const added = await appendQueueVisits([
      { id: 'RQ-1:a1', station: 'READY', pool: 'claude', arrivedAt: base, startedAt: base + 1000, completedAt: base + 1000 },
    ], journalPath);
    expect(added).toBe(1);
    expect(await readQueueVisits(journalPath)).toHaveLength(2);

    const compacted = await compactQueueVisits(journalPath, { now: base + 5000, maxBytes: 1 });
    expect(compacted.compacted).toBe(true);
    expect(compacted.dropped).toBe(1);
    expect(await readQueueVisits(journalPath)).toHaveLength(1);
  });

  it('reads streams with optional byte cap and fatal UTF-8 validation', async () => {
    expect(await readQueueStream(chunksOf(['hello ', Buffer.from('world', 'utf8')]))).toBe('hello world');

    await expect(readQueueStream(chunksOf(['1234', '56']), {
      maxBytes: 5,
      maxBytesError: 'too big',
    })).rejects.toThrow('too big');

    // ignoreBOM: true preserves leading UTF-8 BOM so strict JSON callers reject BOM-prefixed payloads.
    expect(await readQueueStream(chunksOf([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}', 'utf8')]), {
      fatalUtf8: true,
    })).toBe('\ufeff{"ok":true}');

    await expect(readQueueStream(chunksOf([Buffer.from([0xff, 0xfe])]), {
      fatalUtf8: true,
    })).rejects.toThrow();
  });
});
