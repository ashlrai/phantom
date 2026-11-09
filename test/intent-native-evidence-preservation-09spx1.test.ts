import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
const link = { repo: 'example/project', number: 12, title: 'RQ-ALPHA-1 RQ-BETA-1 RQ-GAMMA-1', at };
const ship = { release: 'v1', rq: ['RQ-ALPHA-1', 'RQ-BETA-1', 'RQ-GAMMA-1'], at };
let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup(seed = true) {
  root = await mkdtemp(join(tmpdir(), 'intent-native-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  if (seed) await writeLedger({ ...emptyLedger(), items: [item('alpha', 'queued'), item('beta', 'verified'), item('gamma', 'closed'), item('delta', 'superseded')] }, root);
}
const call = (name: string, args: unknown) => callNativeTool(name, args);

describe('native intent evidence preservation', () => {
  it('advertises closed schemas and append safety', () => {
    for (const name of ['intent_link', 'intent_ship']) {
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(nativeToolSafety(name)).toBe('append');
    }
  });
  it('persists supplied evidence, preserves terminal records and uses existing repeat behavior', async () => {
    await setup();
    const before = await readLedger(root);
    expect((await call('intent_link', link)).isError).not.toBe(true);
    expect((await call('intent_link', link)).isError).not.toBe(true);
    let rows = (await readLedger(root)).items;
    expect(rows.map(row => row.status)).toEqual(['merged', 'verified', 'closed', 'superseded']);
    expect(rows[0]!.prs).toHaveLength(1);
    expect(rows[0]!.evidence).toHaveLength(2);
    expect(rows[3]).toEqual(before.items[3]);
    expect(rows[0]!.provenance).toEqual(before.items[0]!.provenance);
    expect((await call('intent_ship', ship)).isError).not.toBe(true);
    expect((await call('intent_ship', ship)).isError).not.toBe(true);
    rows = (await readLedger(root)).items;
    expect(rows.map(row => row.status)).toEqual(['shipped', 'verified', 'closed', 'superseded']);
    expect(rows[0]!.evidence.filter(row => row.kind === 'release')).toHaveLength(2);
    expect(rows[3]).toEqual(before.items[3]);
  });
  it('leaves unmatched and invalid calls byte-for-byte unchanged', async () => {
    await setup();
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    for (const [name, args] of [
      ['intent_link', { ...link, title: 'unrelated' }], ['intent_ship', { release: 'v1', rq: ['RQ-NOPE-1'] }],
    ] as const) expect((await call(name, args)).isError).not.toBe(true);
    const invalid: [string, unknown][] = [
      ['intent_link', { ...link, extra: 'unknown' }], ['intent_link', { ...link, number: 0 }],
      ['intent_link', { ...link, repo: 'invalid' }], ['intent_link', { ...link, title: '' }],
      ['intent_link', { ...link, at: 'yesterday' }], ['intent_link', null],
      ['intent_ship', { ...ship, extra: 'unknown' }], ['intent_ship', { ...ship, rq: ['bad'] }],
      ['intent_ship', { ...ship, rq: Array(17).fill('RQ-A-1') }], ['intent_ship', { release: 'v1' }],
      ['intent_ship', { ...ship, release: 'x'.repeat(201) }], ['intent_ship', { ...ship, at: 'bad' }],
    ];
    for (const [name, args] of invalid) expect((await call(name, args)).isError).toBe(true);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
  });
  it('refuses secret-shaped metadata and corrupt or missing ledgers without exposing input', async () => {
    await setup();
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    const secret = 'ghp_' + 'a'.repeat(36);
    for (const [name, args] of [['intent_link', { ...link, title: `RQ-ALPHA-1 ${secret}` }], ['intent_ship', { ...ship, notes: secret }]] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
    }
    await writeFile(intentLedgerPath(root), '{bad');
    for (const [name, args] of [['intent_link', link], ['intent_ship', ship]] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('{bad');
      expect(await readFile(intentLedgerPath(root), 'utf8')).toBe('{bad');
    }
    await rm(join(root, 'intent'), { recursive: true });
    for (const [name, args] of [['intent_link', link], ['intent_ship', ship]] as const) expect((await call(name, args)).isError).toBe(true);
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(root, 'intent'));
  });
});
