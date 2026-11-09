import { mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIntentEdit } from '../src/cli/fleet-intent-edit.js';
import { addIntent, updateIntent } from '../src/core/intent/edit.js';
import { getIntent, listIntents } from '../src/core/intent/read.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const NOW = '2026-11-09T12:00:00.000Z';
let dir: string;
let previous: string | undefined;
let lines: string[];
let errors: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'intent-edit-'));
  previous = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = dir;
  lines = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line?: unknown) => { errors.push(String(line)); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previous;
  await rm(dir, { recursive: true, force: true });
});

const run = async (...args: string[]) => ({ code: await cmdFleetIntentEdit([...args, '--json']), body: JSON.parse(lines.at(-1) ?? '{}') as Record<string, any> });
const bytes = () => readFile(intentLedgerPath(dir), 'utf8');

function seedItem(over: Partial<IntentItem>): IntentItem {
  return {
    id: 'seed-1', title: 'Existing directive', source: 'owner', owner: 'owner', rq: ['RQ-SEED-1'],
    prs: [{ repo: 'example/repo', number: 7, state: 'merged' }], status: 'merged',
    evidence: [{ at: NOW, kind: 'pr', ref: 'example/repo#7' }],
    provenance: [{ source: 'owner', date: null, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: NOW, staleAfterMs: 604_800_000, createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}

async function seed(): Promise<void> {
  const ledger = emptyLedger();
  ledger.items.push(seedItem({}), seedItem({ id: 'other-1', title: 'Unrelated', rq: ['RQ-OTHER-1'], prs: [], evidence: [], status: 'queued' }));
  await writeLedger(ledger, dir);
}

describe('intent edit recovery (PR #4235 80f1d451)', () => {
  it('creates, augments and verifies through the real command, then rereads with the current readers', async () => {
    const added = await run('add', '--title', 'Keep directives tracked', '--source', 'owner', '--rq', 'rq-edit-1', '--rq', 'RQ-EDIT-1', '--verbatim');
    expect(added.code).toBe(0);
    const id = added.body['item'].id as string;
    expect(added.body['item']).toMatchObject({ rq: ['RQ-EDIT-1'], status: 'proposed', owner: 'owner' });
    const merged = await run('update', id, '--status', 'merged', '--rq', 'RQ-EDIT-2', '--rq', 'rq-edit-1');
    expect(merged.body['item'].status).toBe('merged');
    const verified = await run('update', id, '--evidence', 'checked-by-owner', '--note', 'caller reported');
    expect(verified.code).toBe(0);
    const item = await getIntent(id, dir);
    expect(item).toMatchObject({ status: 'verified', rq: ['RQ-EDIT-1', 'RQ-EDIT-2'], provenance: [{ source: 'owner', verbatim: true }] });
    expect(item?.evidence).toEqual([expect.objectContaining({ kind: 'verification', ref: 'checked-by-owner', note: 'caller reported' })]);
    const listed = await listIntents({ root: dir, status: 'verified' });
    expect(listed.items.map(row => row.id)).toEqual([id]);
  });

  it('dedupes by sameDirective, keeps provenance, PR evidence and unrelated records', async () => {
    await seed();
    const added = await addIntent({ title: 'Different words', source: 'mac-lane', rq: ['RQ-SEED-1'], status: 'queued', date: '2026-10-01', partial: true, now: NOW }, dir);
    expect(added.id).toBe('seed-1');
    const ledger = await readLedger(dir);
    expect(ledger.items.map(row => row.id)).toEqual(['seed-1', 'other-1']);
    expect(ledger.items[0]).toMatchObject({ status: 'merged', partial: true, prs: [{ number: 7 }], evidence: [{ kind: 'pr' }] });
    expect(ledger.items[0]!.provenance.map(row => row.source)).toEqual(['owner', 'mac-lane']);
    const byTitle = await addIntent({ title: '  UNRELATED  ', source: 'owner', now: NOW }, dir);
    expect(byTitle.id).toBe('other-1');
    expect((await readLedger(dir)).items).toHaveLength(2);
  });

  it('advances only merged/shipped on evidence and keeps other statuses', async () => {
    await seed();
    await updateIntent('other-1', { evidence: { ref: 'note-a' }, now: NOW }, dir);
    expect((await getIntent('other-1', dir))?.status).toBe('queued');
    await updateIntent('other-1', { status: 'shipped', now: NOW }, dir);
    expect((await getIntent('other-1', dir))?.status).toBe('shipped');
    await updateIntent('other-1', { evidence: { ref: 'note-b' }, now: NOW }, dir);
    expect((await getIntent('other-1', dir))?.status).toBe('verified');
    const closed = await updateIntent('seed-1', { status: 'closed', evidence: { ref: 'note-c' }, now: NOW }, dir);
    expect(closed).toMatchObject({ status: 'closed', prs: [{ number: 7 }] });
    expect(closed.evidence.map(row => row.kind)).toEqual(['pr', 'verification']);
  });

  it('leaves bytes unchanged for unknown ids and invalid arguments', async () => {
    await seed();
    const before = await bytes();
    const secretish = 'refused-title-marker';
    for (const args of [
      ['update', 'missing-id', '--title', secretish],
      ['update', 'seed-1', '--status', 'bogus'],
      ['update', 'seed-1', '--evidence'],
      ['update', 'seed-1', '--title', 'a', '--title', 'b'],
      ['update', 'seed-1', '--stale-after', '60000'],
      ['update', 'seed-1', '--note', 'orphan'],
      ['update', 'seed-1'],
      ['add', '--title', secretish, '--source', 'owner', '--evidence', 'x'],
      ['add', '--title', secretish, '--source', 'owner', '--wat'],
      ['add', '--title', secretish, '--source', 'owner', '--stale-after', '5'],
      ['add', '--title', secretish],
      ['add', '--title', secretish, '--source', 'owner', '--rq', 'not-a-key'],
      ['frobnicate'],
    ]) {
      const result = await run(...args);
      expect(result.code, args.join(' ')).not.toBe(0);
      expect(result.body['ok']).toBe(false);
      expect(JSON.stringify(result.body)).not.toContain(secretish);
      expect(await bytes()).toBe(before);
    }
    await expect(updateIntent('seed-1', { rq: Array.from({ length: 16 }, (_, i) => `RQ-MANY-${i}`), now: NOW }, dir)).rejects.toThrow(/at most 16/);
    expect(await bytes()).toBe(before);
  });

  it('propagates a store refusal without leaking the refused contents or paths', async () => {
    await seed();
    await rename(join(dir, 'intent'), join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'intent'));
    const before = await readFile(join(dir, 'real', 'ledger.json'), 'utf8');
    const result = await run('add', '--title', 'Refused body text', '--source', 'owner');
    expect(result.code).toBe(1);
    expect(result.body).toEqual({ ok: false, error: 'Intent directory must be a regular directory.' });
    expect(JSON.stringify(result.body)).not.toContain('Refused body text');
    expect(JSON.stringify(result.body)).not.toContain(dir);
    expect(await readFile(join(dir, 'real', 'ledger.json'), 'utf8')).toBe(before);
  });
});
