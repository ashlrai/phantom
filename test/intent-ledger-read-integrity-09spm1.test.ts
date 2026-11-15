import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyLedger, IntentError, MAX_EVIDENCE, MAX_INTENT_ITEMS, MAX_OWNER, MAX_PROVENANCE, MAX_PRS, MAX_RQ, MAX_SOURCE, MAX_TITLE, type IntentLedger } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';
import { intentSummary } from '../src/core/intent/summary.js';
import { readFleetIntent } from '../src/mcp/fleet-intent-read.js';

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'intent-integrity-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const at = '2026-11-05T00:00:00Z';
function fixture(): IntentLedger {
  return { ...emptyLedger(), items: [{ id: 'synthetic-1', title: 'Synthetic order', source: 'fixture', owner: 'owner',
    rq: ['RQ-TEST-1'], prs: [{ repo: 'example/project', number: 1, state: 'open', url: 'https://example.test/1' }],
    status: 'merged', evidence: [{ at, kind: 'note', ref: 'fixture', note: 'synthetic' }],
    provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }], partial: false,
    closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at }] };
}

it('round trips a full record and treats a missing ledger as empty', async () => {
  const dir = await root();
  expect(await readLedger(dir)).toEqual(emptyLedger());
  await writeLedger(fixture(), dir);
  expect(await readLedger(dir)).toEqual(fixture());
});

it('rejects malformed nested values and existing limits through the real store', async () => {
  const dir = await root();
  await mkdir(join(dir, 'intent'));
  const row = fixture().items[0]!;
  const variants: unknown[] = [
    { rq: [null] }, { rq: ['bad'] }, { rq: Array(MAX_RQ + 1).fill('RQ-TEST') },
    { prs: [null] }, { prs: [[]] }, { prs: [{ ...row.prs[0], repo: 'bad' }] },
    { prs: [{ ...row.prs[0], number: 0 }] }, { prs: [{ ...row.prs[0], number: 1.5 }] },
    { prs: [{ ...row.prs[0], state: 'done' }] }, { prs: [{ ...row.prs[0], url: 5 }] },
    { prs: Array(MAX_PRS + 1).fill(row.prs[0]) },
    { evidence: [null] }, { evidence: [{ ...row.evidence[0], at: 'invalid' }] },
    { evidence: [{ ...row.evidence[0], kind: 'other' }] }, { evidence: [{ ...row.evidence[0], ref: 1 }] },
    { evidence: [{ ...row.evidence[0], note: null }] }, { evidence: Array(MAX_EVIDENCE + 1).fill(row.evidence[0]) },
    { provenance: [[]] }, { provenance: [{ ...row.provenance[0], date: 'invalid' }] },
    { provenance: [{ ...row.provenance[0], source: 1 }] }, { provenance: [{ ...row.provenance[0], verbatim: 1 }] },
    { provenance: [{ ...row.provenance[0], partial: null }] }, { provenance: Array(MAX_PROVENANCE + 1).fill(row.provenance[0]) },
    { title: 'x'.repeat(MAX_TITLE + 1) }, { source: 'x'.repeat(MAX_SOURCE + 1) }, { owner: 'x'.repeat(MAX_OWNER + 1) },
  ];
  for (const patch of variants) {
    await writeFile(intentLedgerPath(dir), JSON.stringify({ ...emptyLedger(), items: [{ ...row, ...patch as object }] }));
    await expect(readLedger(dir)).rejects.toThrow(IntentError);
  }
  await writeFile(intentLedgerPath(dir), JSON.stringify({ ...emptyLedger(), items: Array(MAX_INTENT_ITEMS + 1).fill(row) }));
  await expect(readLedger(dir)).rejects.toThrow(IntentError);
});

it('reports corrupt state as unavailable and rejects MCP reads without changing bytes', async () => {
  const dir = await root();
  await writeLedger(fixture(), dir);
  const path = intentLedgerPath(dir);
  const corrupt = JSON.stringify({ ...emptyLedger(), items: [{ ...fixture().items[0], prs: [null] }] });
  await writeFile(path, corrupt);
  await expect(readLedger(dir)).rejects.toThrow('Intent ledger must be ashlr.intent-ledger/v1.');
  expect(await intentSummary({ root: dir })).toMatchObject({ sourceQuality: 'unavailable', countQuality: 'unknown' });
  await expect(readFleetIntent({ action: 'get', id: 'synthetic-1' }, { read: () => readLedger(dir) })).rejects.toThrow(IntentError);
  await expect(writeLedger(JSON.parse(corrupt) as IntentLedger, dir)).rejects.toThrow(IntentError);
  expect(await readFile(path, 'utf8')).toBe(corrupt);
  const missing = join(dir, 'missing');
  await expect(writeLedger(JSON.parse(corrupt) as IntentLedger, missing)).rejects.toThrow(IntentError);
  await expect(readFile(intentLedgerPath(missing))).rejects.toMatchObject({ code: 'ENOENT' });
});
