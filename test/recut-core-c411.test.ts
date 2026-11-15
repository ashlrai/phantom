import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { intentLedgerPath, readLedger } from '../src/core/intent/store.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => killed }));
vi.mock('../src/core/comms/owner-channel.js', async (load) => ({ ...(await load<typeof import('../src/core/comms/owner-channel.js')>()), fixedOwnerRunsDir: () => root }));
let root: string;
let killed = false;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'recut-core-c411-')); killed = false; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const call = (name: string, args: unknown) => callNativeTool(name, args);

describe('recut core c411: native intent edit field preservation', () => {
  it('persists caller-supplied fields and merges a same-directive add instead of duplicating', async () => {
    for (const name of ['intent_add', 'intent_update']) {
      expect(nativeToolSafety(name)).toBe('append');
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ additionalProperties: false });
    }
    const add = { title: 'Recut directive', source: 'fixture one', rq: ['RQ-RECUT-1'], verbatim: false, staleAfterMs: 120_000, partial: true, status: 'queued' };
    expect((await call('intent_add', add)).isError).toBeFalsy();
    const first = (await readLedger(root)).items[0]!;
    expect(first).toMatchObject({ title: 'Recut directive', source: 'fixture one', owner: 'owner', status: 'queued', rq: ['RQ-RECUT-1'], staleAfterMs: 120_000, partial: true });
    expect(first.provenance).toEqual([{ source: 'fixture one', date: first.provenance[0]!.date, verbatim: false, partial: true }]);

    // A second add naming the same directive merges: one item, appended provenance, unioned RQ keys.
    expect((await call('intent_add', { ...add, source: 'fixture two', rq: ['RQ-RECUT-2'] })).isError).toBeFalsy();
    const merged = await readLedger(root);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]!.id).toBe(first.id);
    expect(merged.items[0]!.rq).toEqual(['RQ-RECUT-1', 'RQ-RECUT-2']);
    expect(merged.items[0]!.provenance.map(row => row.source)).toEqual(['fixture one', 'fixture two']);
    expect(statSync(intentLedgerPath(root)).mode & 0o777).toBe(0o600);
  });

  it('updates named fields only and never invents a record for a missing id', async () => {
    expect((await call('intent_add', { title: 'Tracked directive', source: 'fixture one', rq: ['RQ-TRACK-1'] })).isError).toBeFalsy();
    const id = (await readLedger(root)).items[0]!.id;
    const before = readFileSync(intentLedgerPath(root), 'utf8');

    for (const args of [
      { id: 'int-notarealid0' },
      { id, unknownKey: true },
      { id, staleAfterMs: 1 },
    ] as const) {
      expect((await call('intent_update', args)).isError).toBe(true);
      expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(before);
    }

    expect((await call('intent_update', { id, title: 'Tracked directive v2', partial: false })).isError).toBeFalsy();
    const item = (await readLedger(root)).items[0]!;
    expect(item).toMatchObject({ id, title: 'Tracked directive v2', source: 'fixture one', rq: ['RQ-TRACK-1'], partial: false });
    expect(item.provenance.map(row => row.source)).toEqual(['fixture one']);
  });

  it('rejects malformed adds before any ledger exists and leaves the file absent', async () => {
    for (const args of [
      { source: 'fixture one' },
      { title: 'x', source: 'fixture one', rq: ['bad key'] },
      { title: 'x', source: 'fixture one', staleAfterMs: Number.POSITIVE_INFINITY },
      { title: 'x', source: 'fixture one', verbatim: 'yes' },
    ]) {
      expect((await call('intent_add', args)).isError).toBe(true);
    }
    expect(() => statSync(intentLedgerPath(root))).toThrowError();
    expect((await call('intent_add', { title: 'First directive', source: 'fixture one' })).isError).toBeFalsy();
    expect((await readLedger(root)).items[0]).toMatchObject({ title: 'First directive', status: 'proposed' });
  });
});
