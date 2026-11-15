import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetIntent } from '../src/cli/fleet-intent.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { intentLedgerPath } from '../src/core/intent/store.js';

let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previous;
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

async function run(args: string[], code = 0) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetIntent([...args, '--json'])).toBe(code);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  } finally { log.mockRestore(); }
}

describe.sequential('fleet intent original operations', () => {
  it('resolves the fleet command and persists the requested operations', async () => {
    const resolved = resolveFleetSubcommand('intent')!;
    expect((await FLEET_SUBCOMMAND_LOADERS['intent']!())[resolved.exportName]).toBe(cmdFleetIntent);
    root = await mkdtemp(join(tmpdir(), 'intent-cli-'));
    process.env['ASHLR_RUNS_DIR'] = root;
    const added = await run(['add', '--title', 'Example', '--source', 'test', '--rq', 'RQ-EXAMPLE-1', '--rq', 'RQ-EXAMPLE-2']);
    const id = added.item.id as string;
    expect(added.item.rq).toEqual(['RQ-EXAMPLE-1', 'RQ-EXAMPLE-2']);
    expect(await run(['update', id, '--status', 'queued'])).toMatchObject({ item: { status: 'queued' } });
    expect(await run(['get', id])).toMatchObject({ item: { id } });
    const first = join(root, 'one.jsonl');
    const second = join(root, 'two.jsonl');
    await writeFile(first, JSON.stringify({ title: 'Another', source: 'test', rq_key: 'RQ-OTHER-1' }) + '\n');
    await writeFile(second, JSON.stringify({ title: 'Third', source: 'test', rq_key: 'RQ-OTHER-2' }) + '\n');
    expect(await run(['import', first, second])).toMatchObject({ ok: true, imported: 2 });
    expect((await run(['list'])).records).toHaveLength(3);
    const before = await readFile(intentLedgerPath(), 'utf8');
    expect(await run(['stale'])).toMatchObject({ ok: true, applied: false });
    expect(await readFile(intentLedgerPath(), 'utf8')).toBe(before);
    expect(await run(['list', '--bogus'], 2)).toMatchObject({ ok: false });
    expect(await run(['update', id, '--status', 'bad'], 2)).toMatchObject({ ok: false });
    expect(await run(['get'], 2)).toMatchObject({ ok: false });
    expect(await run(['link', '--repo', 'example/repo', '--number', '1', '--title', 'RQ-EXAMPLE-1', '--url', 'https://example.com/1'])).toMatchObject({ ok: true, updated: 1 });
    expect(await run(['get', id])).toMatchObject({ item: { status: 'merged', prs: [{ url: 'https://example.com/1' }] } });
    expect(await run(['ship', '--release', 'v1', '--rq', 'RQ-EXAMPLE-1', '--rq', 'RQ-EXAMPLE-2'])).toMatchObject({ ok: true, updated: 1 });
    expect(await run(['get', id])).toMatchObject({ item: { status: 'shipped', evidence: expect.arrayContaining([expect.objectContaining({ kind: 'release', ref: 'v1' })]) } });
  });
});
