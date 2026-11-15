import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { addIntent, updateIntent } from '../src/core/intent/edit.js';
import { getIntent, listIntents } from '../src/core/intent/read.js';
import { readLedger } from '../src/core/intent/store.js';

it('round trips a fake directive and verification without changing its neighbor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-audit-'));
  try {
    const now = '2026-01-02T03:04:05.000Z';
    const first = await addIntent({ title: 'Fake audit directive', source: 'fixture', rq: ['RQ-AUDIT-1'], status: 'merged', now }, root);
    const neighbor = await addIntent({ title: 'Separate fake directive', source: 'fixture', rq: ['RQ-NEIGHBOR-1'], now }, root);
    expect((await listIntents({ root, status: 'merged' })).items.map(item => item.id)).toEqual([first.id]);
    expect(await getIntent(first.id, root)).toEqual(first);
    expect(await getIntent('missing-id', root)).toBeNull();
    await expect(updateIntent('missing-id', { owner: 'fixture', now }, root)).rejects.toThrow(/not found/i);
    await updateIntent(first.id, { rq: ['rq-audit-2'], evidence: { ref: 'fake-check', note: 'fixture evidence' }, now }, root);
    const saved = await getIntent(first.id, root);
    expect(saved).toMatchObject({ status: 'verified', rq: ['RQ-AUDIT-1', 'RQ-AUDIT-2'], evidence: [{ kind: 'verification', ref: 'fake-check', note: 'fixture evidence', at: now }] });
    expect((await readLedger(root)).items).toEqual([saved, neighbor]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
