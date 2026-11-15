import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetIntent } from '../src/cli/fleet-intent.js';
import { intentLedgerPath } from '../src/core/intent/store.js';
import type { IntentItem, IntentLedger } from '../src/core/intent/schema.js';

it('persists the unified directive lifecycle and makes evidence replay idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-unified-'));
  const previous = process.env['ASHLR_RUNS_DIR'];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const run = async (args: string[], expected = 0): Promise<Record<string, any>> => {
    log.mockClear();
    error.mockClear();
    expect(await cmdFleetIntent([...args, '--json'])).toBe(expected);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(log.mock.calls[0]?.[0]));
  };
  try {
    process.env['ASHLR_RUNS_DIR'] = root;
    const added = await run(['add', '--title', 'Preserve the directive', '--source', 'owner thread',
      '--owner', 'first owner', '--status', 'queued', '--rq', 'rq-example-1', '--rq', 'RQ-EXAMPLE-2',
      '--date', '2026-11-05T21:46:00Z', '--verbatim']);
    const id = added.item.id as string;
    expect(id).toMatch(/^int-/);
    expect(added.item).toMatchObject({ status: 'queued', rq: ['RQ-EXAMPLE-1', 'RQ-EXAMPLE-2'] });
    const other = (await run(['add', '--title', 'Unrelated directive', '--source', 'other',
      '--status', 'queued', '--rq', 'RQ-OTHER-1'])).item as IntentItem;
    const edited = await run(['update', id, '--owner', 'second owner', '--rq', 'RQ-EXAMPLE-3']);
    expect(edited.item).toMatchObject({ owner: 'second owner', status: 'queued',
      rq: ['RQ-EXAMPLE-1', 'RQ-EXAMPLE-2', 'RQ-EXAMPLE-3'] });
    const link = ['link', '--repo', 'example/project', '--number', '123', '--title', 'Implement RQ-EXAMPLE-1',
      '--branch', 'work/RQ-EXAMPLE-3-fix', '--url', 'https://example.com/project/pull/123'];
    const ship = ['ship', '--release', 'example-v1', '--rq', 'RQ-EXAMPLE-3'];
    expect(await run(link)).toMatchObject({ ok: true, updated: 1 });
    const merged = (await run(['get', id])).item as IntentItem;
    expect(merged.status).toBe('merged');
    expect(merged.evidence.map(row => row.kind)).toEqual(['pr']);
    expect(await run(ship)).toMatchObject({ ok: true, updated: 1 });
    expect((await run(['get', id])).item.status).toBe('shipped');
    const verified = (await run(['update', id, '--evidence', 'example verification', '--notes', 'checked locally'])).item as IntentItem;
    expect(verified).toMatchObject({ id, status: 'verified', source: 'owner thread', owner: 'second owner',
      rq: ['RQ-EXAMPLE-1', 'RQ-EXAMPLE-2', 'RQ-EXAMPLE-3'],
      provenance: [{ source: 'owner thread', date: '2026-11-05T21:46:00Z', verbatim: true, partial: false }],
      prs: [{ repo: 'example/project', number: 123, state: 'merged', url: 'https://example.com/project/pull/123' }],
      evidence: [{ kind: 'pr', ref: 'example/project#123' }, { kind: 'release', ref: 'example-v1' },
        { kind: 'verification', ref: 'example verification', note: 'checked locally' }] });
    expect((await run(['get', id])).item).toEqual(verified);
    const listed = await run(['list']);
    expect(listed.records).toEqual([verified, other]);
    const path = intentLedgerPath(root);
    const ledger = JSON.parse(await readFile(path, 'utf8')) as IntentLedger;
    expect(ledger).toEqual({ schema: 'ashlr.intent-ledger/v1', items: [verified, other] });
    const beforeRefusal = await readFile(path, 'utf8');
    expect(await run(['update', id, '--status', 'not-a-status'], 2)).toMatchObject({ ok: false, error: 'Invalid status.' });
    expect(await readFile(path, 'utf8')).toBe(beforeRefusal);
    await run(link);
    await run(ship);
    const replayed = (await run(['get', id])).item as IntentItem;
    expect(replayed.status).toBe('verified');
    expect(replayed.prs).toEqual(verified.prs);
    expect(replayed.evidence.map(({ kind, ref, note }) => ({ kind, ref, note })))
      .toEqual(verified.evidence.map(({ kind, ref, note }) => ({ kind, ref, note })));
    expect((await run(['get', other.id])).item).toEqual(other);
  } finally {
    log.mockRestore();
    error.mockRestore();
    if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
