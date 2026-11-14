import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Spy on the intent store before mcp-native loads it, so the ship path can be
// shown never to read the ledger (recut of #5203: readLedger moved behind the
// presence check and past the intent_ship early return).
vi.mock('../src/core/intent/store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/intent/store.js')>();
  return { ...mod, readLedger: vi.fn(mod.readLedger) };
});

import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { EVIDENCE_SCHEMAS } from '../src/core/intent/mcp-evidence.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-14T08:00:00.000Z';
const item = (id: string, status: IntentItem['status']): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }], partial: false,
  closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});
const link = { repo: 'example/project', number: 12, title: 'RQ-ALPHA-1 merged', at };
const ship = { release: 'v1', rq: ['RQ-ALPHA-1'], at };

let root = '';
let home = '';
const saved = { runs: process.env['ASHLR_RUNS_DIR'], home: process.env['HOME'] };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(async () => {
  restore('ASHLR_RUNS_DIR', saved.runs); restore('HOME', saved.home);
  for (const dir of [root, home]) if (dir) await rm(dir, { recursive: true, force: true });
  root = home = '';
});
async function setup(seed: boolean) {
  home = await mkdtemp(join(tmpdir(), 'recut-c346-home-'));
  root = await mkdtemp(join(tmpdir(), 'recut-c346-'));
  process.env['HOME'] = home;
  process.env['ASHLR_RUNS_DIR'] = root;
  if (seed) await writeLedger({ ...emptyLedger(), items: [item('alpha', 'queued')] }, root);
  vi.mocked(readLedger).mockClear();
}

describe('recut of #5203: intent_link / intent_ship share EVIDENCE_SCHEMAS', () => {
  it('registers both tools once each with the shared schema objects and no duplicate names', () => {
    const tools = listNativeTools();
    const names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter(n => n === 'intent_import')).toHaveLength(1);
    for (const name of ['intent_link', 'intent_ship'] as const) {
      const tool = tools.find(t => t.name === name);
      expect(tool?.inputSchema).toBe(EVIDENCE_SCHEMAS[name]);
      expect(tool?.description).toContain('never verifies');
      expect(nativeToolSafety(name)).toBe('append');
    }
  });

  it('intent_link records through the shared handler and reads the ledger', async () => {
    await setup(true);
    expect((await callNativeTool('intent_link', link)).isError).not.toBe(true);
    expect(vi.mocked(readLedger).mock.calls.length).toBeGreaterThan(0);
    expect((await readLedger(root)).items[0]!.status).toBe('merged');
  });

  it('intent_ship records without recordEvidence itself reading the ledger', async () => {
    await setup(true);
    expect((await callNativeTool('intent_ship', ship)).isError).not.toBe(true);
    // The single read comes from noteShippedRelease downstream; the recut moves
    // recordEvidence's own readLedger() below the ship early return.
    expect(vi.mocked(readLedger)).toHaveBeenCalledTimes(1);
    expect((await readLedger(root)).items[0]!.status).toBe('shipped');
  });

  it('invalid args are rejected by validEvidenceArgs before any ledger access', async () => {
    await setup(true);
    for (const [name, args] of [
      ['intent_link', { ...link, number: 0 }],
      ['intent_link', null],
      ['intent_ship', { release: 'v1', extra: 'x' }],
    ] as const) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
    expect(vi.mocked(readLedger)).not.toHaveBeenCalled();
  });

  it('a missing ledger reports unavailable without attempting a read', async () => {
    await setup(false);
    for (const [name, args] of [['intent_link', link], ['intent_ship', ship]] as const) {
      const res = await callNativeTool(name, args);
      expect(res.isError).toBe(true);
    }
    expect(vi.mocked(readLedger)).not.toHaveBeenCalled();
  });
});
