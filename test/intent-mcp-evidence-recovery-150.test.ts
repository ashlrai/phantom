import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-05T21:46:00.000Z';
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
  home = await mkdtemp(join(tmpdir(), 'intent-evidence-home-'));
  root = await mkdtemp(join(tmpdir(), 'intent-evidence-'));
  process.env['HOME'] = home;
  process.env['ASHLR_RUNS_DIR'] = root;
  if (seed) await writeLedger({ ...emptyLedger(), items: [item('alpha', 'queued'), item('beta', 'queued')] }, root);
}
const call = (name: string, args: unknown) => callNativeTool(name, args);

describe('native intent evidence recovery (#5020)', () => {
  it('lists strict append tools while keeping existing tools', () => {
    const names = listNativeTools().map(t => t.name);
    for (const name of ['intent_link', 'intent_ship']) {
      expect(listNativeTools().find(t => t.name === name)?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(nativeToolSafety(name)).toBe('append');
    }
    expect(names).toEqual(expect.arrayContaining(['phantom_fleet_verbs', 'phantom_agent_bus_read']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('records supplied evidence without verifying, closing or touching unrelated directives', async () => {
    await setup(true);
    const before = await readLedger(root);
    const linked = await call('intent_link', link);
    expect(linked.isError).not.toBe(true);
    let rows = (await readLedger(root)).items;
    expect(rows.map(r => r.status)).toEqual(['merged', 'queued']);
    expect(rows[0]!.prs).toHaveLength(1);
    expect(rows[1]).toEqual(before.items[1]);
    expect((await call('intent_ship', ship)).isError).not.toBe(true);
    rows = (await readLedger(root)).items;
    expect(rows.map(r => r.status)).toEqual(['shipped', 'queued']);
    expect(rows[0]!.closureProposal).toBeNull();
    expect(rows[1]).toEqual(before.items[1]);
  });

  it('rejects malformed or extra fields without mutating the ledger', async () => {
    await setup(true);
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    const invalid: [string, unknown][] = [
      ['intent_link', { ...link, extra: 'x' }], ['intent_link', { ...link, number: 0 }],
      ['intent_link', { ...link, repo: 'invalid' }], ['intent_link', { ...link, at: 'yesterday' }], ['intent_link', null],
      ['intent_ship', { ...ship, extra: 'x' }], ['intent_ship', { ...ship, rq: ['bad'] }],
      ['intent_ship', { ...ship, rq: Array(17).fill('RQ-A-1') }], ['intent_ship', { release: 'v1' }],
    ];
    for (const [name, args] of invalid) expect((await call(name, args)).isError).toBe(true);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
  });

  it('does not fabricate success or create a ledger when none exists', async () => {
    await setup(false);
    for (const [name, args] of [['intent_link', link], ['intent_ship', ship]] as const) expect((await call(name, args)).isError).toBe(true);
    await expect(readFile(intentLedgerPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
