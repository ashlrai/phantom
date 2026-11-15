import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools } from '../src/core/mcp-native.js';
import { EVIDENCE_SCHEMAS } from '../src/core/intent/mcp-evidence.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-05T21:46:00.000Z';
const directive: IntentItem = {
  id: 'alpha', title: 'alpha', source: 'fixture-source', owner: 'fixture', rq: ['RQ-ALPHA-1'], prs: [],
  status: 'queued', evidence: [], provenance: [{ source: 'fixture-source', date: null, verbatim: true, partial: false }],
  partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
};
const link = { repo: 'example/project', number: 12, title: 'RQ-ALPHA-1', url: 'https://example.test/pull/12', at };
const ship = { release: 'example-v1', rq: ['RQ-ALPHA-1'], at };
let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});
async function setup(seed = true): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-wire-197s-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  if (seed) await writeLedger({ ...emptyLedger(), items: [structuredClone(directive)] }, root);
}

describe('native intent evidence delegation', () => {
  it('lists the shared schemas without creating a ledger', async () => {
    await setup(false);
    for (const name of ['intent_link', 'intent_ship'] as const) {
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toEqual(EVIDENCE_SCHEMAS[name]);
    }
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('validates before mutation and records caller evidence without verification', async () => {
    await setup();
    const before = await readFile(intentLedgerPath(root), 'utf8');
    expect((await callNativeTool('intent_link', { ...link, number: 0 })).isError).toBe(true);
    expect((await callNativeTool('intent_ship', { ...ship, extra: true })).isError).toBe(true);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
    expect((await callNativeTool('intent_link', link)).isError).not.toBe(true);
    expect((await callNativeTool('intent_ship', ship)).isError).not.toBe(true);
    const row = (await readLedger(root)).items[0]!;
    expect(row.status).toBe('shipped');
    expect(row.source).toBe('fixture-source');
    expect(row.provenance).toEqual(directive.provenance);
    expect(row.prs).toEqual([{ repo: link.repo, number: link.number, state: 'merged', url: link.url }]);
    expect(row.evidence).toEqual([{ at, kind: 'pr', ref: 'example/project#12' }, { at, kind: 'release', ref: ship.release }]);
  });
  it('reports a missing ledger as unavailable', async () => {
    await setup(false);
    for (const [name, args] of [['intent_link', link], ['intent_ship', ship]] as const) {
      const result = await callNativeTool(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('Intent ledger unavailable.');
    }
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
