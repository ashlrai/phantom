import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { addIntent, getIntent, intentSummary, listIntents, updateIntent } from '../src/core/intent/ledger.js';
import { intentLedgerPath } from '../src/core/intent/store.js';

const now = '2026-11-09T12:00:00.000Z';
const input = { id: 'fake-1', title: 'Fake directive for testing', source: 'fixture', now };
const roots: string[] = [];
async function seed() {
  const root = await mkdtemp(join(tmpdir(), 'intent-failure-'));
  roots.push(root);
  await addIntent(input, root);
  return { root, path: intentLedgerPath(root) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([
  ['invalid JSON', Buffer.from('{broken'), /not valid JSON/],
  ['invalid structure', Buffer.from('{"schema":"ashlr.intent-ledger/v1","items":[null]}'), /must be ashlr.intent-ledger/],
  ['oversized', Buffer.alloc(2 * 1024 * 1024 + 1, 32), /under 2 MiB/],
])('refuses %s without changing bytes until explicit fixture repair', async (_label, corrupt, error) => {
  const { root, path } = await seed();
  const saved = await readFile(path);
  await writeFile(path, corrupt);
  for (const operation of [
    () => listIntents({ root, nowMs: Date.parse(now) }),
    () => getIntent(input.id, root),
    () => addIntent({ ...input, id: 'fake-2' }, root),
    () => updateIntent(input.id, { title: 'Changed', now }, root),
  ]) {
    await expect(operation()).rejects.toThrow(error);
    expect((await readFile(path)).equals(corrupt)).toBe(true);
  }
  expect(await intentSummary({ root, nowMs: Date.parse(now) })).toMatchObject({
    sourceQuality: 'unavailable', countQuality: 'unknown', present: false,
  });
  expect((await readFile(path)).equals(corrupt)).toBe(true);
  await writeFile(path, saved); // Explicit repair of this synthetic fixture.
  expect(await getIntent(input.id, root)).toMatchObject({ id: input.id, title: input.title, source: input.source });
  await updateIntent(input.id, { owner: 'fixture-owner', now }, root);
  expect(await getIntent(input.id, root)).toMatchObject({ id: input.id, title: input.title, owner: 'fixture-owner' });
});

it('refuses a partially applied invalid update and permits a later valid update', async () => {
  const { root, path } = await seed();
  const saved = await readFile(path);
  await expect(updateIntent(input.id, { title: 'Changed in memory', owner: '', now }, root)).rejects.toThrow(/Owner/);
  expect(await readFile(path)).toEqual(saved);
  expect(await getIntent(input.id, root)).toMatchObject({ id: input.id, title: input.title });
  await updateIntent(input.id, { owner: 'fixture-owner', now }, root);
  expect(await getIntent(input.id, root)).toMatchObject({ id: input.id, title: input.title, owner: 'fixture-owner' });
});
