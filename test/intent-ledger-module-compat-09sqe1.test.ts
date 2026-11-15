import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as ledger from '../src/core/intent/ledger.js';
import * as read from '../src/core/intent/read.js';
import * as edit from '../src/core/intent/edit.js';
import * as imports from '../src/core/intent/import.js';
import * as summary from '../src/core/intent/summary.js';
import * as evidence from '../src/core/intent/evidence.js';
import * as release from '../src/core/intent/release.js';
import * as sweep from '../src/core/intent/sweep.js';
import type { IntentAddInput, IntentUpdateInput, IntentSummary, MergedPullNote, ShippedReleaseNote, SweepRow } from '../src/core/intent/ledger.js';

it('exposes the original path as the same operations and persists through the shared store', async () => {
  expect(ledger).toMatchObject({
    listIntents: read.listIntents, getIntent: read.getIntent,
    addIntent: edit.addIntent, updateIntent: edit.updateIntent,
    importIntentFiles: imports.importIntentFiles, isStale: summary.isStale,
    summarize: summary.summarize, intentSummary: summary.intentSummary,
    linkMergedPull: evidence.linkMergedPull, markShipped: evidence.markShipped,
    noteShippedRelease: release.noteShippedRelease, sweepStale: sweep.sweepStale,
  });
  const root = await mkdtemp(join(tmpdir(), 'intent-compat-'));
  try {
    const input: IntentAddInput = { title: 'Example directive', source: 'unknown', rq: ['RQ-FAKE-123'], now: '2026-11-01T00:00:00.000Z' };
    const patch: IntentUpdateInput = { status: 'merged', now: '2026-11-02T00:00:00.000Z' };
    const note: ShippedReleaseNote = { release: 'v0.0.0-fake', notes: 'RQ-FAKE-123' };
    const pull: MergedPullNote = { repo: 'example/fake', number: 1, title: 'RQ-FAKE-123' };
    expect(pull.number).toBe(1);
    const item = await ledger.addIntent(input, root);
    expect(await ledger.getIntent(item.id, root)).toEqual(item);
    const listing = await ledger.listIntents({ root });
    const resultSummary: IntentSummary = listing.summary;
    expect(resultSummary.items).toBe(1);
    expect(listing.items).toEqual([item]);
    await ledger.updateIntent(item.id, patch, root);
    expect((await ledger.noteShippedRelease(note, { root, now: '2026-11-03T00:00:00.000Z' })).updated).toBe(1);
    const reread = await ledger.getIntent(item.id, root);
    expect(reread).toMatchObject({ source: 'unknown', status: 'shipped' });
    expect(await read.getIntent(item.id, root)).toEqual(reread);
    expect((await read.listIntents({ root })).items).toEqual([reread]);
    const rows: SweepRow[] = (await ledger.sweepStale({ root, now: '2026-11-04T00:00:00.000Z' })).stale;
    expect(rows).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
