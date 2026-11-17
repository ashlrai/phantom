import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools } from '../src/core/mcp-native.js';
import { EVIDENCE_SCHEMAS } from '../src/core/intent/mcp-evidence.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

// Preserves the integration from PR #5196 (head 6daad989): the native tools must expose the
// shared EVIDENCE_SCHEMAS verbatim and drive the real handler. All fixtures are fake.
const at = '2026-11-05T21:46:00.000Z';
const item: IntentItem = {
  id: 'alpha', title: 'alpha', source: 'fixture', owner: 'fixture', rq: ['RQ-ALPHA-1'], prs: [], status: 'queued',
  evidence: [], provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }], partial: false,
  closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
};
let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
const previousHome = process.env['HOME'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});
async function setup(seed = true): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-schema-206s-'));
  process.env['HOME'] = root;
  process.env['ASHLR_RUNS_DIR'] = root;
  if (seed) await writeLedger({ ...emptyLedger(), items: [item] }, root);
}

describe('native intent evidence uses the shared schema (PR #5196)', () => {
  it('tools/list schemas are the shared EVIDENCE_SCHEMAS, not copies', () => {
    const listed = listNativeTools();
    for (const name of ['intent_link', 'intent_ship'] as const) {
      expect(listed.find(t => t.name === name)?.inputSchema).toBe(EVIDENCE_SCHEMAS[name]);
    }
    expect(EVIDENCE_SCHEMAS.intent_link.required).toEqual(['repo', 'number', 'title']);
    expect(EVIDENCE_SCHEMAS.intent_ship.required).toEqual(['release']);
  });

  it('every advertised property is accepted and unknown ones are rejected without writing', async () => {
    await setup();
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    const bad = await callNativeTool('intent_link', { repo: 'example/project', number: 1, title: 'RQ-ALPHA-1', sneaky: 1 });
    expect(bad.isError).toBe(true);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
    const ok = await callNativeTool('intent_link', { repo: 'example/project', number: 1, title: 'RQ-ALPHA-1',
      branch: 'fix/alpha', url: 'https://example.invalid/pull/1', at });
    expect(ok.isError).not.toBe(true);
  });

  it('valid link then ship append evidence only: no verification, closure or dispatch', async () => {
    await setup();
    expect((await callNativeTool('intent_link', { repo: 'example/project', number: 7, title: 'RQ-ALPHA-1', at })).isError).not.toBe(true);
    expect((await callNativeTool('intent_ship', { release: 'v0.0.1', rq: ['RQ-ALPHA-1'], notes: 'claimed by caller', at })).isError).not.toBe(true);
    const [row] = (await readLedger(root)).items;
    expect(row!.status).toBe('shipped');
    expect(row!.closureProposal).toBeNull();
    expect(row!.evidence.map(e => e.kind).sort()).toEqual(['pr', 'release']);
    expect(row!.evidence.some(e => e.kind === 'verification')).toBe(false);
  });

  it('a missing ledger is reported unavailable on both tools and is never created', async () => {
    await setup(false);
    for (const [name, args] of [['intent_link', { repo: 'example/project', number: 1, title: 'x' }], ['intent_ship', { release: 'v1', notes: 'n' }]] as const) {
      const r = await callNativeTool(name, args);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).toContain('Intent ledger unavailable.');
    }
    await expect(readFile(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
