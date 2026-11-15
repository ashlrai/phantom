import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('exposes recovered operations and round trips a caller ID through the compatibility ledger', async () => {
  const ledger = await import('../src/core/intent/ledger.js');
  for (const name of [
    'listIntents', 'getIntent', 'addIntent', 'updateIntent', 'importIntentFiles',
    'isStale', 'summarize', 'intentSummary', 'linkMergedPull', 'markShipped',
    'noteShippedRelease', 'sweepStale',
  ] as const) expect(typeof ledger[name]).toBe('function');

  const root = await mkdtemp(join(tmpdir(), 'intent-export-audit-'));
  try {
    const now = '2026-11-05T21:46:00.000Z';
    const item = await ledger.addIntent({ id: 'fake-audit-id', title: 'Fake directive', source: 'fixture', now }, root);
    expect(item.id).toBe('fake-audit-id');
    expect(await ledger.getIntent(item.id, root)).toEqual(item);
    await ledger.updateIntent(item.id, { owner: 'fake-owner', rq: ['RQ-FAKE-1'], now }, root);
    const saved = await ledger.getIntent(item.id, root);
    expect(saved).toMatchObject({ id: item.id, owner: 'fake-owner', rq: ['RQ-FAKE-1'] });
    expect((await ledger.listIntents({ root })).items).toEqual([saved]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
