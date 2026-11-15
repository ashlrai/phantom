import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importIntentFiles } from '../src/core/intent/import.js';
import { intentLedgerPath } from '../src/core/intent/store.js';
import { intentSummary } from '../src/core/intent/summary.js';
import { cmdFleetIntentEvidence } from '../src/cli/fleet-intent-evidence.js';
import { cmdFleetIntentRead } from '../src/cli/fleet-intent-read.js';
import { readFleetIntent } from '../src/mcp/fleet-intent-read.js';

it('preserves imported intent through merge and persisted release evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-roundtrip-'));
  const previous = process.env['ASHLR_RUNS_DIR'];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const run = async (command: (args: string[]) => Promise<number>, args: string[]) => {
    log.mockClear();
    error.mockClear();
    const code = await command([...args, '--json']);
    expect(code).toBe(0);
    expect(error).not.toHaveBeenCalled();
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  };
  try {
    process.env['ASHLR_RUNS_DIR'] = root;
    const input = join(root, 'fake-directives.json');
    await writeFile(input, JSON.stringify([
      { id: 'alpha', title: 'Example directive', source: 'fake source', date: '2026-11-01T00:00:00Z', verbatim: true, rq: 'RQ-ALPHA-1', status: 'queued' },
      { id: 'beta', title: 'Unrelated directive', rq: 'RQ-BETA-1', status: 'queued' },
      { id: 'terminal', title: 'Terminal directive', rq: 'RQ-TERMINAL-1', status: 'closed' },
    ]));
    expect(await importIntentFiles([input])).toEqual({ imported: 3, deduped: 0, items: 3 });
    expect(await importIntentFiles([input])).toEqual({ imported: 0, deduped: 3, items: 3 });
    const path = intentLedgerPath();
    const initial = await readFile(path, 'utf8');
    const merge = ['merged', '--repo', 'example/project', '--number', '123', '--title', 'RQ-ALPHA-1 RQ-TERMINAL-1', '--at', '2026-11-05T21:46:00Z'];
    const preview = await run(cmdFleetIntentEvidence, merge);
    expect(preview).toEqual({ dryRun: true, applied: false, matches: [{ id: 'alpha', status: 'merged' }, { id: 'terminal', status: 'closed' }] });
    expect(await readFile(path, 'utf8')).toBe(initial);
    expect(await run(cmdFleetIntentEvidence, [...merge, '--apply'])).toEqual({ ...preview, dryRun: false, applied: true });
    const merged = await run(cmdFleetIntentRead, ['get', 'alpha']);
    expect(merged.item.status).toBe('merged');
    expect(merged.item.evidence).toEqual([{ at: '2026-11-05T21:46:00Z', kind: 'pr', ref: 'example/project#123' }]);
    expect((await intentSummary()).shipped).toBe(0);
    expect((await intentSummary()).verified).toBe(0);
    const beforeRelease = await readFile(path, 'utf8');
    const release = ['shipped', '--release', 'fake-v1', '--rq', 'RQ-ALPHA-1', '--at', '2026-11-06T00:00:00Z'];
    const releasePreview = await run(cmdFleetIntentEvidence, release);
    expect(releasePreview).toEqual({ dryRun: true, applied: false, matches: [{ id: 'alpha', status: 'shipped' }] });
    expect(await readFile(path, 'utf8')).toBe(beforeRelease);
    expect(await run(cmdFleetIntentEvidence, [...release, '--apply'])).toEqual({ ...releasePreview, dryRun: false, applied: true });
    const cli = await run(cmdFleetIntentRead, ['list']);
    expect(cli.records.map((item: { status: string }) => item.status)).toEqual(['shipped', 'queued', 'closed']);
    const fresh = await readFleetIntent({ action: 'get', id: 'alpha' });
    expect(fresh.action === 'get' && fresh.found).toBe(true);
    if (fresh.action !== 'get' || !fresh.found) throw new Error('Missing persisted directive');
    expect(fresh.item).toMatchObject({ id: 'alpha', status: 'shipped', source: 'fake source', rq: ['RQ-ALPHA-1'],
      provenance: [{ source: 'fake source', date: '2026-11-01T00:00:00Z', verbatim: true, partial: false }],
      prs: [{ repo: 'example/project', number: 123, state: 'merged' }],
      evidence: [{ kind: 'pr', ref: 'example/project#123' }, { kind: 'release', ref: 'fake-v1' }] });
    const summary = await intentSummary();
    expect(summary).toMatchObject({ items: 3, merged: 0, shipped: 1, verified: 0 });
  } finally {
    log.mockRestore();
    error.mockRestore();
    if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
