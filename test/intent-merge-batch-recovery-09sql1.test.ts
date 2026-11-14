import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as ledger from '../src/core/intent/ledger.js';
import * as mergeBatch from '../src/core/intent/merge-batch.js';
import { addIntent, getIntent, listIntents, noteMergedPulls } from '../src/core/intent/ledger.js';
import { intentLedgerPath, ledgerFilePresent, readLedger } from '../src/core/intent/store.js';
import type { MergedPullNote } from '../src/core/intent/ledger.js';
import type { IntentItem } from '../src/core/intent/schema.js';

const NOW = '2026-11-09T12:00:00.000Z';
const EARLIER = '2026-10-01T00:00:00.000Z';
const roots: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'intent-merge-batch-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seed(dir: string): Promise<Record<string, IntentItem>> {
  const items: Record<string, IntentItem> = {};
  items['one'] = await addIntent({ title: 'First directive', source: 'owner', rq: ['RQ-BATCH-ONE'], status: 'in-progress', now: EARLIER }, dir);
  items['two'] = await addIntent({ title: 'Second directive', source: 'owner', rq: ['RQ-BATCH-TWO'], status: 'verified', now: EARLIER }, dir);
  items['three'] = await addIntent({ title: 'Third directive', source: 'owner', rq: ['RQ-BATCH-THREE'], status: 'shipped', now: EARLIER }, dir);
  items['four'] = await addIntent({ title: 'Unmatched directive', source: 'owner', rq: ['RQ-BATCH-FOUR'], status: 'queued', now: EARLIER }, dir);
  return items;
}

function prRows(item: IntentItem): IntentItem['prs'] {
  return item.prs;
}

it('is re-exported from the ledger compatibility module', () => {
  expect(ledger.noteMergedPulls).toBe(mergeBatch.noteMergedPulls);
});

it('returns zero on an empty ledger without creating the file', async () => {
  const dir = await root();
  const pulls: MergedPullNote[] = [{ repo: 'example/fake', number: 1, title: 'RQ-BATCH-ONE' }];
  expect(await noteMergedPulls(pulls, { root: dir, now: NOW })).toEqual({ updated: 0 });
  expect(await ledgerFilePresent(dir)).toBe(false);
});

it('persists a whole batch once: two PRs on one directive count it once, statuses never regress', async () => {
  const dir = await root();
  const items = await seed(dir);
  const pulls: MergedPullNote[] = [
    { repo: 'example/fake', number: 11, title: 'bridge: RQ-BATCH-ONE', url: 'https://example.com/fake/pull/11' },
    { repo: 'example/fake', number: 12, title: 'unrelated title', branch: 'cursor/RQ-BATCH-ONE-fix' },
    { repo: 'other/fake', number: 5, title: 'ship RQ-BATCH-TWO', url: 'https://example.com/other/pull/5' },
    { repo: 'other/fake', number: 6, title: 'ship RQ-BATCH-THREE' },
    { repo: 'not a repo', number: 9, title: 'RQ-BATCH-ONE' },
    { repo: 'example/fake', number: 13, title: 'no directive key here' },
  ];
  expect(await noteMergedPulls(pulls, { root: dir, now: NOW })).toEqual({ updated: 3 });

  const disk = await readLedger(dir);
  const one = disk.items.find((item) => item.id === items['one']!.id)!;
  const two = disk.items.find((item) => item.id === items['two']!.id)!;
  const three = disk.items.find((item) => item.id === items['three']!.id)!;
  const four = disk.items.find((item) => item.id === items['four']!.id)!;

  expect(one.status).toBe('merged');
  expect(prRows(one).map((pull) => pull.number).sort()).toEqual([11, 12]);
  expect(one.evidence.filter((row) => row.kind === 'pr').map((row) => row.ref).sort())
    .toEqual(['example/fake#11', 'example/fake#12']);
  expect(one.evidence.every((row) => row.at === NOW)).toBe(true);

  expect(two.status).toBe('verified');
  expect(prRows(two)).toEqual([{ repo: 'other/fake', number: 5, state: 'merged', url: 'https://example.com/other/pull/5' }]);

  expect(three.status).toBe('shipped');
  expect(prRows(three).map((pull) => pull.number)).toEqual([6]);

  expect(four.prs).toEqual([]);
  expect(four.evidence).toEqual([]);
  expect(four.status).toBe('queued');

  // A fresh reread through the public readers sees the same persisted bytes.
  expect(await getIntent(one.id, dir)).toEqual(one);
  expect((await listIntents({ root: dir })).items).toEqual(disk.items);
});

it('replays a batch without duplicating PR or evidence records', async () => {
  const dir = await root();
  const items = await seed(dir);
  const pulls: MergedPullNote[] = [
    { repo: 'example/fake', number: 11, title: 'RQ-BATCH-ONE' },
    { repo: 'example/fake', number: 12, title: 'RQ-BATCH-ONE take two' },
    { repo: 'other/fake', number: 5, title: 'RQ-BATCH-TWO' },
  ];
  expect(await noteMergedPulls(pulls, { root: dir, now: NOW })).toEqual({ updated: 2 });
  const before = await readFile(intentLedgerPath(dir), 'utf8');
  expect(await noteMergedPulls(pulls, { root: dir, now: '2026-11-10T00:00:00.000Z' })).toEqual({ updated: 2 });
  const after = await readLedger(dir);
  const one = after.items.find((item) => item.id === items['one']!.id)!;
  const two = after.items.find((item) => item.id === items['two']!.id)!;
  expect(prRows(one)).toHaveLength(2);
  expect(one.evidence.filter((row) => row.kind === 'pr')).toHaveLength(2);
  expect(one.status).toBe('merged');
  expect(two.status).toBe('verified');
  expect(prRows(two)).toHaveLength(1);
  expect(two.evidence.filter((row) => row.kind === 'pr')).toHaveLength(1);
  expect(await readFile(intentLedgerPath(dir), 'utf8')).toBe(before);
});

it('dedupes evidence when a repeated pull overlaps a batch with a new pull', async () => {
  const dir = await root();
  const items = await seed(dir);
  const repeat: MergedPullNote = { repo: 'example/fake', number: 11, title: 'RQ-BATCH-ONE' };
  const fresh: MergedPullNote = { repo: 'example/fake', number: 20, title: 'RQ-BATCH-FOUR' };
  await noteMergedPulls([repeat], { root: dir, now: NOW });
  expect(await noteMergedPulls([repeat, fresh], { root: dir, now: NOW })).toEqual({ updated: 2 });
  const one = (await readLedger(dir)).items.find((item) => item.id === items['one']!.id)!;
  expect(prRows(one)).toHaveLength(1);
  expect(one.evidence.filter((row) => row.kind === 'pr' && row.ref === 'example/fake#11')).toHaveLength(1);
  const four = (await readLedger(dir)).items.find((item) => item.id === items['four']!.id)!;
  expect(four.status).toBe('merged');
  expect(prRows(four).map((pull) => pull.number)).toEqual([20]);
});

it('handles empty and malformed batches without partial writes', async () => {
  const dir = await root();
  const items = await seed(dir);
  const before = await readFile(intentLedgerPath(dir), 'utf8');

  expect(await noteMergedPulls([], { root: dir, now: NOW })).toEqual({ updated: 0 });
  expect(await readFile(intentLedgerPath(dir), 'utf8')).toBe(before);

  await expect(noteMergedPulls('nope' as unknown as MergedPullNote[], { root: dir, now: NOW }))
    .rejects.toThrow('Merged pulls must be an array.');
  await expect(noteMergedPulls([{ repo: 'example/fake', number: 1, title: 'RQ-BATCH-ONE' }], { root: dir, now: 'not a time' }))
    .rejects.toThrow('Time must be an ISO timestamp.');

  // A bad pull number refuses the whole batch: the earlier good pull is not persisted.
  await expect(noteMergedPulls([
    { repo: 'example/fake', number: 30, title: 'RQ-BATCH-ONE' },
    { repo: 'example/fake', number: 0, title: 'RQ-BATCH-TWO' },
  ], { root: dir, now: NOW })).rejects.toThrow('owner/name and a pull number');
  expect(await readFile(intentLedgerPath(dir), 'utf8')).toBe(before);
  const one = await getIntent(items['one']!.id, dir);
  expect(one!.prs).toEqual([]);
  expect(one!.status).toBe('in-progress');
});
