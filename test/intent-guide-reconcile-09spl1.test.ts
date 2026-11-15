import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetIntentImport } from '../src/cli/fleet-intent-import.js';
import { cmdFleetIntentRead } from '../src/cli/fleet-intent-read.js';
import { cmdFleetIntentEvidence } from '../src/cli/fleet-intent-evidence.js';
import { cmdFleetIntentSummary } from '../src/cli/fleet-intent-summary.js';
import { cmdFleetIntentSweep } from '../src/cli/fleet-intent-sweep.js';
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

async function run(handler: (args: string[]) => Promise<number>, args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await handler([...args, '--json']);
    expect(code).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  } finally { log.mockRestore(); }
}

describe('intent guide workflow', () => {
  it('imports fake copies, previews and records linked evidence, then rereads', async () => {
    root = await mkdtemp(join(tmpdir(), 'intent-guide-'));
    process.env['ASHLR_RUNS_DIR'] = root;
    const seed = join(root, 'seed.json');
    const copies = join(root, 'copies.jsonl');
    await writeFile(seed, JSON.stringify([{ id: 'demo-1', title: 'Example directive', source: 'fake-seed', owner: 'example', rq: 'RQ-DEMO-1', status: 'queued', date: '2026-11-05T21:46:00Z', verbatim: true }]));
    await writeFile(copies, `${JSON.stringify({ title: 'Example directive...', source: 'fake-copy', rq_key: 'RQ-DEMO-1', status: 'queued' })}\n${JSON.stringify({ id: 'demo-2', title: 'Another example', source: 'fake-copy', rq_key: 'RQ-DEMO-2', status: 'proposed' })}\n`);
    expect(await run(cmdFleetIntentImport, [seed, copies])).toMatchObject({ ok: true, imported: 2, deduped: 1, items: 2 });
    expect(await run(cmdFleetIntentRead, ['list'])).toMatchObject({ ok: true, records: [{ id: 'demo-1', rq: ['RQ-DEMO-1'], partial: true }, { id: 'demo-2' }] });
    expect(await run(cmdFleetIntentRead, ['get', 'demo-1'])).toMatchObject({ ok: true, item: { status: 'queued', provenance: [{ source: 'fake-seed', verbatim: true }, { source: 'fake-copy', partial: true }] } });
    const merged = ['merged', '--repo', 'example/project', '--number', '42', '--title', 'RQ-DEMO-1 example'];
    const shipped = ['shipped', '--release', 'example-v1', '--rq', 'RQ-DEMO-1'];
    for (const [args, status] of [[merged, 'merged'], [shipped, 'shipped']] as const) {
      const before = await readFile(intentLedgerPath(), 'utf8');
      expect(await run(cmdFleetIntentEvidence, args)).toEqual({ dryRun: true, applied: false, matches: [{ id: 'demo-1', status }] });
      expect(await readFile(intentLedgerPath(), 'utf8')).toBe(before);
      expect(await run(cmdFleetIntentEvidence, [...args, '--apply'])).toEqual({ dryRun: false, applied: true, matches: [{ id: 'demo-1', status }] });
      expect(await readFile(intentLedgerPath(), 'utf8')).not.toBe(before);
      expect(await run(cmdFleetIntentRead, ['get', 'demo-1'])).toMatchObject({ item: { status } });
    }
    expect(await run(cmdFleetIntentSummary, [])).toMatchObject({ sourceQuality: 'readable', countQuality: 'observed', items: 2, shipped: 1 });
    expect(await run(cmdFleetIntentSweep, ['--now', '2026-11-06T00:00:00Z'])).toMatchObject({ applied: false, updated: 0 });
  });

  it('points to the current fleet commands', async () => {
    const guide = await readFile(new URL('../docs/INTENT.md', import.meta.url), 'utf8');
    for (const verb of ['intent-read', 'intent-import', 'intent-evidence', 'intent-summary', 'intent-sweep']) expect(guide).toContain(`phm fleet ${verb}`);
    expect(guide).not.toMatch(/phm intent (?:list|get|add|update|import|stale|link|ship)/);
  });
});
