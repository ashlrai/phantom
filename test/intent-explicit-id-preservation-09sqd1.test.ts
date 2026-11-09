import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addIntent } from '../src/core/intent/edit.js';
import { getIntent, listIntents } from '../src/core/intent/read.js';
import { emptyLedger, validIntentId, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

// Recovery of caller-supplied intent IDs from PR #4235 (80f1d451). Fake labels only, temp roots only.
const NOW = '2026-11-09T12:00:00.000Z';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-explicit-id-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function seedItem(over: Partial<IntentItem>): IntentItem {
  return {
    id: 'fake-seed-1', title: 'Fake existing directive', source: 'fixture', owner: 'owner', rq: ['RQ-FAKESEED-1'],
    prs: [], status: 'proposed', evidence: [],
    provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: NOW, staleAfterMs: 604_800_000, createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}

async function seed(): Promise<void> {
  const ledger = emptyLedger();
  ledger.items.push(seedItem({}));
  await writeLedger(ledger, root);
}

const bytes = () => readFile(intentLedgerPath(root), 'utf8');

describe('explicit intent id preservation (PR #4235 80f1d451)', () => {
  it('persists a caller-supplied id and retrieves it through readLedger, getIntent and listIntents', async () => {
    const added = await addIntent({ id: 'fake-source-id-1', title: 'Fake stable directive', source: 'fixture', rq: ['RQ-FAKESTABLE-1'], now: NOW }, root);
    expect(added.id).toBe('fake-source-id-1');

    const ledger = await readLedger(root);
    expect(ledger.items.map(item => item.id)).toEqual(['fake-source-id-1']);

    const fetched = await getIntent('fake-source-id-1', root);
    expect(fetched).toMatchObject({ id: 'fake-source-id-1', title: 'Fake stable directive', rq: ['RQ-FAKESTABLE-1'], status: 'proposed' });

    const listed = await listIntents({ root });
    expect(listed.items.map(item => item.id)).toEqual(['fake-source-id-1']);
    expect(await bytes()).toContain('"id":"fake-source-id-1"');
  });

  it('generates a valid id when none is supplied', async () => {
    const added = await addIntent({ title: 'Fake generated directive', source: 'fixture', now: NOW }, root);
    expect(added.id).toMatch(/^int-[0-9a-f]{16}$/);
    expect(validIntentId(added.id)).toBe(true);
    expect(await getIntent(added.id, root)).toMatchObject({ id: added.id });
  });

  it('accepts the full allowed id alphabet and maximum length', async () => {
    const longest = `A${'b.:_-9'.repeat(13)}xy`;
    expect(longest).toHaveLength(81);
    const added = await addIntent({ id: longest, title: 'Fake longest id', source: 'fixture', now: NOW }, root);
    expect(added.id).toBe(longest);
    expect(await getIntent(longest, root)).not.toBeNull();
  });

  it('rejects invalid supplied ids without changing the existing ledger bytes or creating a ledger', async () => {
    await seed();
    const before = await bytes();
    const invalid: unknown[] = ['', ' padded', '-leading', 'has space', 'slash/inside', 'emoji-\u{1F40D}', 'x'.repeat(82), 123, null, ['fake-array-id']];
    for (const id of invalid) {
      await expect(addIntent({ id, title: 'Fake refused directive', source: 'fixture', now: NOW } as never, root), String(id))
        .rejects.toThrow('Intent id must be 1 to 81 letters, digits, or . _ : -.');
      expect(await bytes()).toBe(before);
    }
    expect((await readLedger(root)).items.map(item => item.id)).toEqual(['fake-seed-1']);

    await rm(intentLedgerPath(root), { force: true });
    await expect(addIntent({ id: 'bad id', title: 'Fake refused directive', source: 'fixture', now: NOW }, root)).rejects.toThrow();
    await expect(readFile(intentLedgerPath(root), 'utf8')).rejects.toThrow();
  });

  it('keeps both records with distinct ids when a supplied id collides with a different directive', async () => {
    await seed();
    const before = (await readLedger(root)).items[0];

    const added = await addIntent({ id: 'fake-seed-1', title: 'Fake unrelated directive', source: 'fixture', rq: ['RQ-FAKEOTHER-1'], now: NOW }, root);

    expect(added.id).not.toBe('fake-seed-1');
    expect(validIntentId(added.id)).toBe(true);
    expect(added.id).toMatch(/^int-[0-9a-f]{16}$/);
    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(2);
    expect(new Set(ledger.items.map(item => item.id)).size).toBe(2);
    expect(await getIntent('fake-seed-1', root)).toEqual(before);
    expect(await getIntent(added.id, root)).toMatchObject({ title: 'Fake unrelated directive', rq: ['RQ-FAKEOTHER-1'] });
  });

  it('retains the original id and provenance on a matching RQ key even when a different id is supplied', async () => {
    await seed();
    const added = await addIntent({
      id: 'fake-new-caller-id', title: 'Fake reworded directive', source: 'fixture-lane', rq: ['rq-fakeseed-1'],
      status: 'queued', date: '2026-10-01', verbatim: true, now: NOW,
    }, root);

    expect(added.id).toBe('fake-seed-1');
    const ledger = await readLedger(root);
    expect(ledger.items.map(item => item.id)).toEqual(['fake-seed-1']);
    expect(await getIntent('fake-new-caller-id', root)).toBeNull();
    expect(ledger.items[0]).toMatchObject({ status: 'queued', rq: ['RQ-FAKESEED-1'] });
    expect(ledger.items[0]!.provenance.map(row => row.source)).toEqual(['fixture', 'fixture-lane']);
  });

  it('retains the original id on a matching normalized title when the supplied id matches nothing', async () => {
    await seed();
    const added = await addIntent({ id: 'fake-title-caller-id', title: '  FAKE   EXISTING DIRECTIVE... ', source: 'fixture', now: NOW }, root);

    expect(added.id).toBe('fake-seed-1');
    expect((await readLedger(root)).items).toHaveLength(1);
    expect(await getIntent('fake-title-caller-id', root)).toBeNull();
  });

  it('keeps a supplied id that matches the same directive as the existing record without duplicating it', async () => {
    await seed();
    const added = await addIntent({ id: 'fake-seed-1', title: 'Fake existing directive', source: 'fixture', now: NOW }, root);
    expect(added.id).toBe('fake-seed-1');
    expect((await readLedger(root)).items.map(item => item.id)).toEqual(['fake-seed-1']);
  });
});
