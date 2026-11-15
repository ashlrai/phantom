import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdFleetIntent } from '../src/cli/fleet-intent.js';
import { intentLedgerPath } from '../src/core/intent/store.js';

let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previous;
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function run(args: string[], code = 0) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetIntent([...args, '--json'])).toBe(code);
    expect(log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(log.mock.calls[0]![0]));
  } finally { log.mockRestore(); }
}

describe.sequential('original unified intent output', () => {
  it('reports original summary fields for empty, populated, and filtered lists', async () => {
    root = await mkdtemp(join(tmpdir(), 'intent-output-'));
    process.env['ASHLR_RUNS_DIR'] = root;
    expect(await run(['list'])).toEqual({ ok: true, schema: 'ashlr.intent-ledger/v1', present: false, sourceQuality: 'missing', countQuality: 'observed', items: 0, tracked: 0, merged: 0, shipped: 0, verified: 0, stale: 0, partial: 0, staleItems: [], records: [] });
    const first = await run(['add', '--title', 'First directive', '--source', 'test', '--rq', 'RQ-EXAMPLE-1', '--status', 'queued']);
    await run(['add', '--title', 'Second directive', '--source', 'test', '--status', 'shipped']);
    const all = await run(['list']);
    expect(all).toMatchObject({ ok: true, schema: 'ashlr.intent-ledger/v1', present: true, sourceQuality: 'readable', countQuality: 'observed', items: 2, tracked: 1, merged: 0, shipped: 1, verified: 0, stale: 0, partial: 0, staleItems: [] });
    expect(all.records).toHaveLength(2);
    const filtered = await run(['list', '--status', 'queued']);
    expect(filtered).toMatchObject({ items: 2, tracked: 1, shipped: 1, records: [{ id: first.item.id, status: 'queued', provenance: expect.any(Array) }] });
    expect(await run(['get', first.item.id])).toEqual({ ok: true, item: first.item });
    expect(await run(['get', 'missing'], 2)).toEqual({ ok: false, error: 'Intent not found. Run phm intent list.' });
    expect(await run(['get'], 2)).toMatchObject({ ok: false });
    expect(await run(['list', '--status', 'invalid'], 2)).toMatchObject({ ok: false });
    expect(await run(['update', 'missing', '--title', 'New'], 2)).toMatchObject({ ok: false });
    expect(await run(['import', join(root, 'missing.jsonl')], 2)).toMatchObject({ ok: false });
  });

  it('fails closed for malformed and unreadable ledgers', async () => {
    root = await mkdtemp(join(tmpdir(), 'intent-output-'));
    process.env['ASHLR_RUNS_DIR'] = root;
    const path = intentLedgerPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{broken');
    expect(await run(['list'], 2)).toMatchObject({ ok: false });
    expect(await run(['get', 'missing'], 2)).toMatchObject({ ok: false });
    expect(await run(['add', '--title', 'Example', '--source', 'test'], 2)).toMatchObject({ ok: false });
    await rm(path);
    await mkdir(path);
    expect(await run(['list'], 2)).toMatchObject({ ok: false });
  });
});
