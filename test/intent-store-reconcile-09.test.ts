import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as profile from '../src/core/connectors/profile.js';
import { emptyLedger, normalizeRq, normalizeTitle, rqKeysIn, sameDirective, titleIsPartial, type IntentItem } from '../src/core/intent/schema.js';
import { assertLedgerText, intentLedgerPath, ledgerFilePresent, readLedger, writeLedger } from '../src/core/intent/store.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'intent-reconcile-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const item: IntentItem = {
  id: 'directive-1', title: 'Keep the backlog...', source: 'owner note', owner: 'Mason',
  rq: ['RQ-BACKLOG-1'], prs: [{ repo: 'ashlrai/phantom', number: 42, state: 'open' }],
  status: 'in-progress', evidence: [{ at: '2026-11-05T00:00:00Z', kind: 'note', ref: 'note-1' }],
  provenance: [{ source: 'owner note', date: '2026-11-05', verbatim: true, partial: true }],
  partial: true, closureProposal: null, lastTouchedAt: '2026-11-05T00:00:00Z',
  staleAfterMs: 1000, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
};

describe('intent ledger reconciliation', () => {
  it('normalizes RQ keys and identifies directives by key or normalized title', () => {
    expect(normalizeRq(' rq-backlog-1 ')).toBe('RQ-BACKLOG-1');
    expect(() => normalizeRq('invalid')).toThrow();
    expect(rqKeysIn('rq-backlog-1 and RQ-BACKLOG-1')).toEqual(['RQ-BACKLOG-1']);
    expect(normalizeTitle('  Keep   the backlog...')).toBe('keep the backlog');
    expect(titleIsPartial(item.title)).toBe(true);
    expect(sameDirective(item, { rq: [], title: 'keep the backlog' })).toBe(true);
    expect(sameDirective(item, { rq: ['RQ-BACKLOG-1'], title: 'Different' })).toBe(true);
    expect(sameDirective(item, { rq: [], title: 'Different' })).toBe(false);
  });

  it('reads a missing file as empty and atomically replaces private files', async () => {
    const dir = await root();
    expect(await readLedger(dir)).toEqual(emptyLedger());
    expect(await ledgerFilePresent(dir)).toBe(false);
    const ledger = { ...emptyLedger(), items: [item] };
    await writeLedger(ledger, dir);
    expect(await readLedger(dir)).toEqual(ledger);
    expect(await ledgerFilePresent(dir)).toBe(true);
    const before = await stat(intentLedgerPath(dir));
    await writeLedger({ ...ledger, items: [{ ...item, title: 'Updated directive' }] }, dir);
    const after = await stat(intentLedgerPath(dir));
    expect(after.ino).not.toBe(before.ino);
    expect((await readLedger(dir)).items[0]?.title).toBe('Updated directive');
    expect(await readdir(join(dir, 'intent'))).toEqual(['ledger.json']);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'intent'))).mode & 0o777).toBe(0o700);
      expect(after.mode & 0o777).toBe(0o600);
    }
  });

  it('refuses malformed, wrong-schema, nonregular, symlinked and oversized files', async () => {
    const dir = await root();
    await mkdir(join(dir, 'intent'));
    const path = intentLedgerPath(dir);
    await writeFile(path, '{');
    await expect(readLedger(dir)).rejects.toThrow('JSON');
    await writeFile(path, JSON.stringify({ schema: 'other', items: [] }));
    await expect(readLedger(dir)).rejects.toThrow('ashlr.intent-ledger/v1');
    await writeFile(path, JSON.stringify({ schema: emptyLedger().schema, items: [{}] }));
    await expect(readLedger(dir)).rejects.toThrow('ashlr.intent-ledger/v1');
    await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(readLedger(dir)).rejects.toThrow('regular file');
    await rm(path);
    await mkdir(path);
    await expect(readLedger(dir)).rejects.toThrow('regular file');
    await rm(path, { recursive: true });
    const target = join(dir, 'target');
    await writeFile(target, JSON.stringify(emptyLedger()));
    await symlink(target, path);
    await expect(readLedger(dir)).rejects.toThrow('regular file');
    expect(await ledgerFilePresent(dir)).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify(emptyLedger()));
  });

  it('uses the metadata safety check before writing', async () => {
    const dir = await root();
    const check = vi.spyOn(profile, 'assertMetadata').mockImplementation(() => { throw new Error('refused'); });
    const ledger = { ...emptyLedger(), items: [item] };
    expect(() => assertLedgerText(ledger)).toThrow('refused');
    await expect(writeLedger(ledger, dir)).rejects.toThrow('refused');
    expect(check).toHaveBeenCalled();
    expect(await ledgerFilePresent(dir)).toBe(false);
  });
});
