import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-11T00:00:00.000Z';
const item = (id: string, status: IntentItem['status']): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }], partial: false,
  closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});

let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  if (root) await rm(root, { recursive: true, force: true });
});

describe('recut-core-n3-c149: recovered intent evidence native tools', () => {
  it('exposes intent evidence tools and rejects invalid evidence', async () => {
    for (const name of ['intent_link', 'intent_ship']) {
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ additionalProperties: false });
      expect(nativeToolSafety(name)).toBe('append');
      expect((await callNativeTool(name, { extra: true })).isError).toBe(true);
    }
  });

  it('links a merged pull onto matching ledger directives', async () => {
    root = await mkdtemp(join(tmpdir(), 'recut-n3-c149-'));
    process.env['ASHLR_RUNS_DIR'] = root;
    await writeLedger({ ...emptyLedger(), items: [item('alpha', 'queued')] }, root);
    const result = await callNativeTool('intent_link', { repo: 'example/project', number: 4844, title: 'RQ-ALPHA-1 bridge recut', at });
    expect(result.isError).not.toBe(true);
    const ledger = await readLedger(root);
    expect(ledger.items[0]!.status).toBe('merged');
    expect(ledger.items[0]!.prs[0]).toMatchObject({ repo: 'example/project', number: 4844, state: 'merged' });
  });
});
