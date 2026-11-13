import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativeEdit, validNativeEdit } from '../src/core/intent/native-edit.js';
import { readLedger } from '../src/core/intent/store.js';
import { listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/comms/owner-channel.js', async (load) => ({
  ...(await load<typeof import('../src/core/comms/owner-channel.js')>()),
  fixedOwnerRunsDir: () => root,
}));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'recut-c216-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('recut #4516: native intent edit tools', () => {
  it('nativeEdit writes a real directive through the ledger and updateIntent folds evidence', async () => {
    const added = (await nativeEdit('intent_add', {
      title: 'Ship the recut', source: 'recut-core-oldest-c216', rq: ['RQ-PHX-RECUTCOREOLDC216'],
    })) as { ok: true; item: { id: string } };
    expect(added.item.id).toMatch(/^int-[0-9a-f]{16}$/);

    const updated = (await nativeEdit('intent_update', {
      id: added.item.id, status: 'merged', evidence: 'squash-merged on master',
    })) as { ok: true; item: { status: string } };
    expect(updated.item.status).toBe('verified');

    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({
      title: 'Ship the recut', status: 'verified', rq: ['RQ-PHX-RECUTCOREOLDC216'],
      evidence: [{ ref: 'squash-merged on master' }],
    });
  });

  it('validNativeEdit enforces the wire contract that the JSON schema cannot express', () => {
    expect(validNativeEdit('intent_add', { title: 't', source: 's' })).toBe(true);
    expect(validNativeEdit('intent_add', { title: 't', source: 's', extra: 1 })).toBe(false);
    expect(validNativeEdit('intent_update', { id: 'int-0000000000000000' })).toBe(true);
    expect(validNativeEdit('intent_update', { id: 'not-an-intent-id' })).toBe(false);
    expect(validNativeEdit('intent_add', { title: 't' })).toBe(false);
  });

  it('the gateway advertises both edit tools as append-class', () => {
    const names = listNativeTools().map(tool => tool.name);
    expect(names).toContain('intent_add');
    expect(names).toContain('intent_update');
    expect(nativeToolSafety('intent_add')).toBe('append');
    expect(nativeToolSafety('intent_update')).toBe('append');
  });
});
