import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

// Recovered from PR #5065 (test/intent-native-evidence-preservation-09spx1.test.ts) against
// the registered native MCP dispatch path. All repos, PR numbers, RQ keys and releases are fake.
const at = '2026-11-05T21:46:00.000Z';
const CANARY = 'CANARY-183-DO-NOT-ECHO';
const item = (id: string, status: IntentStatus): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }], partial: false,
  closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});
const link = { repo: 'example/project', number: 12, title: 'RQ-ALPHA-1 RQ-BETA-1 RQ-GAMMA-1', at };
const ship = { release: 'v1', rq: ['RQ-ALPHA-1', 'RQ-BETA-1', 'RQ-GAMMA-1'], at };
const call = (name: string, args: unknown) => callNativeTool(name, args);

let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function setup(seed = true): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-native-183-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  if (seed) {
    await writeLedger({ ...emptyLedger(), items: [
      item('alpha', 'queued'), item('beta', 'verified'), item('gamma', 'closed'), item('delta', 'superseded'),
    ] }, root);
  }
}

describe('native intent evidence (PR #5065 recovery)', () => {
  it('registers both evidence tools as closed, append-class tools and keeps existing native tools', () => {
    const names = listNativeTools().map(tool => tool.name);
    for (const name of ['intent_link', 'intent_ship']) {
      expect(names).toContain(name);
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(nativeToolSafety(name)).toBe('append');
    }
    expect(names).toContain('phantom_agent_bus_read');
    expect(names).toContain('phantom_agent_bus_post');
  });

  it('records a merged pull as merged evidence and never as verified or closed', async () => {
    await setup();
    const before = await readLedger(root);
    const result = await call('intent_link', link);
    expect(result.isError).not.toBe(true);
    const after = (await readLedger(root)).items;
    expect(after.map(row => row.status)).toEqual(['merged', 'verified', 'closed', 'superseded']);
    expect(after[0]!.prs).toEqual([{ repo: 'example/project', number: 12, state: 'merged' }]);
    expect(after[0]!.evidence.map(row => row.kind)).toEqual(['pr']);
    expect(after.flatMap(row => row.evidence).some(row => row.kind === 'verification')).toBe(false);
    expect(after[3]).toEqual(before.items[3]);
    expect(after[0]!.provenance).toEqual(before.items[0]!.provenance);
  });

  it('repeating the same merged pull does not duplicate the PR association', async () => {
    await setup();
    expect((await call('intent_link', link)).isError).not.toBe(true);
    expect((await call('intent_link', link)).isError).not.toBe(true);
    const rows = (await readLedger(root)).items;
    expect(rows[0]!.prs).toHaveLength(1);
    expect(rows[0]!.evidence).toHaveLength(2);
  });

  it('records a release as shipped evidence, preserves verified and closed directives, and never verifies', async () => {
    await setup();
    const before = await readLedger(root);
    expect((await call('intent_ship', ship)).isError).not.toBe(true);
    expect((await call('intent_ship', ship)).isError).not.toBe(true);
    const rows = (await readLedger(root)).items;
    expect(rows.map(row => row.status)).toEqual(['shipped', 'verified', 'closed', 'superseded']);
    expect(rows[0]!.evidence.filter(row => row.kind === 'release')).toHaveLength(2);
    expect(rows[0]!.evidence.some(row => row.kind === 'verification')).toBe(false);
    // Verified and closed directives named by the release keep their status and gain only the release row.
    expect(rows[1]!.status).toBe('verified');
    expect(rows[2]!.status).toBe('closed');
    expect(rows[1]!.evidence.map(row => row.kind)).toEqual(['release', 'release']);
    expect(rows[2]!.evidence.map(row => row.kind)).toEqual(['release', 'release']);
    // An unnamed directive is untouched.
    expect(rows[3]).toEqual(before.items[3]);
  });

  it('a merged pull followed by a release moves the directive to shipped, not verified', async () => {
    await setup();
    expect((await call('intent_link', link)).isError).not.toBe(true);
    expect((await call('intent_ship', ship)).isError).not.toBe(true);
    expect((await readLedger(root)).items[0]!.status).toBe('shipped');
  });

  it('leaves unmatched calls and every malformed call byte-for-byte unchanged', async () => {
    await setup();
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    for (const [name, args] of [
      ['intent_link', { ...link, title: 'unrelated' }], ['intent_ship', { release: 'v1', rq: ['RQ-NOPE-1'] }],
    ] as const) expect((await call(name, args)).isError).not.toBe(true);
    const invalid: [string, unknown][] = [
      ['intent_link', { ...link, extra: 'unknown' }], ['intent_link', { ...link, number: 0 }],
      ['intent_link', { ...link, repo: 'invalid' }], ['intent_link', { ...link, repo: 'owner/name/extra' }],
      ['intent_link', { ...link, repo: 'a b/c' }], ['intent_link', { ...link, number: 1.5 }],
      ['intent_link', { ...link, number: '12' }], ['intent_link', { ...link, title: '' }],
      ['intent_link', { ...link, at: 'yesterday' }], ['intent_link', { ...link, at: '2026-11-05T21:46:00' }],
      ['intent_link', { ...link, at: '2026-13-45T00:00:00Z' }], ['intent_link', { ...link, url: 'x'.repeat(2049) }],
      ['intent_link', { ...link, branch: '   ' }], ['intent_link', null],
      ['intent_ship', { ...ship, extra: 'unknown' }], ['intent_ship', { ...ship, rq: ['bad'] }],
      ['intent_ship', { ...ship, rq: ['RQ-ALPHA-1 EXTRA'] }], ['intent_ship', { ...ship, rq: [] }],
      ['intent_ship', { ...ship, rq: Array(17).fill('RQ-A-1') }], ['intent_ship', { release: 'v1' }],
      ['intent_ship', { ...ship, release: '' }], ['intent_ship', { ...ship, release: 'x'.repeat(201) }],
      ['intent_ship', { ...ship, at: 'bad' }], ['intent_ship', { ...ship, notes: 'n'.repeat(10001) }],
    ];
    for (const [name, args] of invalid) expect((await call(name, args)).isError).toBe(true);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
  });

  it('refuses secret-shaped metadata and corrupt or missing ledgers without echoing caller input', async () => {
    await setup();
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    const secret = 'ghp_' + 'a'.repeat(36);
    for (const [name, args] of [
      ['intent_link', { ...link, title: `RQ-ALPHA-1 ${secret}` }],
      ['intent_ship', { ...ship, notes: secret }],
      ['intent_link', { ...link, repo: `${CANARY} bad/name`, title: 'RQ-ALPHA-1' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(CANARY);
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
    for (const [name, args] of [['intent_link', link], ['intent_ship', ship]] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('Intent ledger unavailable.');
    }
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(root, 'intent'));
  });

  it('reports an absent ledger as unavailable and does not create one', async () => {
    await setup(false);
    for (const [name, args] of [['intent_link', link], ['intent_ship', ship]] as const) {
      expect((await call(name, args)).isError).toBe(true);
    }
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
