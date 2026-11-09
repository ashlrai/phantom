import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import { readLedger } from '../src/core/intent/store.js';

it('merges separate source files by RQ while retaining an unrelated directive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-original-audit-'));
  try {
    const first = join(root, 'first.jsonl');
    const second = join(root, 'second.jsonl');
    await writeFile(first, [
      JSON.stringify({ id: 'one', title: 'Route the model…', source: 'first', date: '2026-10-06', rq_key: 'RQ-ROUTER-1', status: 'queued', verbatim: true }),
      JSON.stringify({ id: 'other', title: 'Another directive', source: 'first', rq_key: 'RQ-OTHER-1', status: 'proposed' }),
    ].join('\n'));
    await writeFile(second, JSON.stringify({ id: 'two', title: 'Route the model from core', source: 'second', date: '2026-10-20', rq_key: 'RQ-ROUTER-1', status: 'in-progress' }));
    expect(await importIntentFiles([first, second], { root, now: '2026-11-09T12:00:00Z' })).toMatchObject({ imported: 2, deduped: 1, items: 2 });
    const ledger = await readLedger(root);
    expect(ledger.items.find(item => item.id === 'one')).toMatchObject({ status: 'in-progress', partial: true, rq: ['RQ-ROUTER-1'], provenance: [{ source: 'first', verbatim: true }, { source: 'second' }] });
    expect(ledger.items.find(item => item.id === 'other')).toMatchObject({ title: 'Another directive', rq: ['RQ-OTHER-1'], status: 'proposed' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
