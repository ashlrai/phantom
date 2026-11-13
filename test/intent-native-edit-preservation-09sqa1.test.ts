import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { readLedger, intentLedgerPath } from '../src/core/intent/store.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/comms/owner-channel.js', async (load) => ({ ...(await load<typeof import('../src/core/comms/owner-channel.js')>()), fixedOwnerRunsDir: () => root }));
let root: string;
const killPath = () => join(process.env.HOME!, '.ashlr', 'KILL');
const armKill = () => {
  mkdirSync(join(process.env.HOME!, '.ashlr'), { recursive: true, mode: 0o700 });
  writeFileSync(killPath(), 'kill switch active\n', { mode: 0o600 });
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'intent-native-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(killPath(), { force: true }); });
const call = (name: string, args: unknown) => callNativeTool(name, args);

describe('native intent edit preservation', () => {
  it('advertises append tools and preserves tracking through real dispatch', async () => {
    for (const name of ['intent_add', 'intent_update']) {
      expect(nativeToolSafety(name)).toBe('append');
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ additionalProperties: false });
    }
    const add = { title: 'Fake directive', source: 'fixture one', rq: ['RQ-FAKE-1'], verbatim: true };
    expect((await call('intent_add', add)).isError).toBeFalsy();
    const id = (await readLedger(root)).items[0]!.id;
    expect((await call('intent_add', { ...add, source: 'fixture two', rq: ['RQ-FAKE-2'] })).isError).toBeFalsy();
    expect((await call('intent_update', { id, owner: 'fixture owner', rq: ['RQ-FAKE-3'], status: 'merged', evidence: 'fixture verification' })).isError).toBeFalsy();
    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({ owner: 'fixture owner', rq: ['RQ-FAKE-1', 'RQ-FAKE-2', 'RQ-FAKE-3'], status: 'verified', evidence: [{ ref: 'fixture verification' }] });
    expect(ledger.items[0]!.provenance.map(row => row.source)).toEqual(['fixture one', 'fixture two']);
    expect(statSync(intentLedgerPath(root)).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(intentLedgerPath(root), 'utf8');
    for (const [name, args] of [
      ['intent_update', { id: 'int-0000000000000000' }], ['intent_update', { id, root: '/tmp' }],
      ['intent_update', { id, evidence: { ref: 'bad' } }], ['intent_add', { ...add, rq: ['bad'] }],
      ['intent_add', { ...add, staleAfterMs: Infinity }], ['intent_update', { id, partial: 'yes' }],
      ['intent_update', { id, status: 'bad' }],
    ] as const) expect((await call(name, args)).isError).toBe(true);
    expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(bytes);
    armKill();
    expect((await call('intent_add', add)).isError).toBe(true);
    expect((await call('intent_update', { id, owner: 'another' })).isError).toBe(true);
    expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(bytes);
  });
});
