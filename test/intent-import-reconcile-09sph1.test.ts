import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIntentImport } from '../src/cli/fleet-intent-import.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { emptyLedger } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

let dir: string;
let previous: string | undefined;
let lines: string[];
let errors: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'intent-import-'));
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

const run = async (...args: string[]) => ({ code: await cmdFleetIntentImport(args), body: JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown> });
const ledgerText = () => readFile(intentLedgerPath(dir), 'utf8');

async function seedFiles(): Promise<{ mac: string; core: string }> {
  const mac = join(dir, 'mac-seed.jsonl');
  const core = join(dir, 'core.json');
  await writeFile(mac, [
    JSON.stringify({ id: 'mac-1', title: 'Route the model…', source: 'mac-lane', date: '2026-10-06', rq_key: 'RQ-ROUTER-1', status: 'queued', verbatim: true }),
    JSON.stringify({ id: 'mac-2', title: 'A second idea', source: 'mac-lane', date: '2026-10-07', rq_key: 'RQ-OTHER-1', status: 'done' }),
  ].join('\n'));
  await writeFile(core, JSON.stringify({ items: [
    { id: 'core-1', title: 'Route the model from core', source: 'core-memory', date: '2026-10-20', rq_key: 'RQ-ROUTER-1', status: 'in-progress' },
  ] }));
  return { mac, core };
}

describe('fleet intent-import', () => {
  it('is found by the fleet convention dispatch', () => {
    expect(resolveFleetSubcommand('intent-import')).toEqual({ module: './fleet-intent-import.js', exportName: 'cmdFleetIntentImport' });
  });

  it('imports JSONL and a JSON document, deduping by RQ and keeping provenance', async () => {
    const { mac, core } = await seedFiles();
    const { code, body } = await run(mac, core, '--json');
    expect(code).toBe(0);
    expect(body).toEqual({ ok: true, imported: 2, deduped: 1, items: 2 });
    const ledger = await readLedger(dir);
    const routed = ledger.items.find((row) => row.id === 'mac-1')!;
    expect(routed.status).toBe('in-progress');
    expect(routed.partial).toBe(true);
    expect(routed.provenance.map((row) => row.source).sort()).toEqual(['core-memory', 'mac-lane']);
    expect(routed.provenance.find((row) => row.source === 'mac-lane')).toMatchObject({ verbatim: true, date: '2026-10-06', partial: true });
    expect(routed.rq).toEqual(['RQ-ROUTER-1']);
    // vague "done" is never promoted to verified/shipped
    expect(ledger.items.find((row) => row.id === 'mac-2')?.status).toBe('closed');
    expect(ledger.items.every((row) => row.evidence.length === 0)).toBe(true);
  });

  it('is idempotent on repeat import', async () => {
    const { mac, core } = await seedFiles();
    await run(mac, core, '--json');
    const first = await ledgerText();
    const { code, body } = await run(mac, core, '--json');
    expect(code).toBe(0);
    expect(body).toEqual({ ok: true, imported: 0, deduped: 3, items: 2 });
    expect(await ledgerText()).toBe(first);
  });

  it('preserves existing records, PRs and evidence', async () => {
    const at = '2026-10-01T00:00:00.000Z';
    const ledger = emptyLedger();
    ledger.items.push({
      id: 'keep-1', title: 'Existing directive', source: 'owner', owner: 'owner', rq: ['RQ-KEEP-1'],
      prs: [{ repo: 'ashlrai/phantom', number: 7, state: 'merged' }], status: 'shipped',
      evidence: [{ at, kind: 'release', ref: 'v1.0.0' }],
      provenance: [{ source: 'owner', date: null, verbatim: true, partial: false }],
      partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 604800000, createdAt: at, updatedAt: at,
    });
    await writeLedger(ledger, dir);
    const file = join(dir, 'again.jsonl');
    await writeFile(file, JSON.stringify({ title: 'Existing directive restated', source: 'other-lane', rq_key: 'rq-keep-1', status: 'proposed' }));
    expect((await run(file, '--json')).code).toBe(0);
    const kept = (await readLedger(dir)).items;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: 'keep-1', status: 'shipped', evidence: [{ kind: 'release', ref: 'v1.0.0' }], prs: [{ number: 7 }] });
    expect(kept[0]!.provenance.map((row) => row.source)).toEqual(['owner', 'other-lane']);
  });

  it('marks a clipped title partial', async () => {
    const file = join(dir, 'long.jsonl');
    await writeFile(file, JSON.stringify({ id: 'long-1', title: 'x'.repeat(400), source: 'fake-lane' }));
    expect((await run(file, '--json')).code).toBe(0);
    const item = (await readLedger(dir)).items[0]!;
    expect(item.title.length).toBe(300);
    expect(item).toMatchObject({ partial: true });
    expect(item.provenance[0]!.partial).toBe(true);
  });

  it('leaves the ledger unchanged when a later file is malformed', async () => {
    const { mac } = await seedFiles();
    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, 'SECRET-LOOKING-FAKE-TEXT not json\n');
    const { code, body } = await run(mac, bad, '--json');
    expect(code).toBe(1);
    expect(body['ok']).toBe(false);
    expect(JSON.stringify(body)).not.toContain('SECRET-LOOKING');
    await expect(readFile(intentLedgerPath(dir), 'utf8')).rejects.toThrow();
  });

  it('prints help without state and rejects bad arguments', async () => {
    expect(await cmdFleetIntentImport(['--help'])).toBe(0);
    expect(lines.join('\n')).toContain('intent-import');
    await expect(readFile(intentLedgerPath(dir), 'utf8')).rejects.toThrow();
    expect((await run('--json')).code).toBe(2);
    expect((await run(join(dir, 'a.jsonl'), '--bogus', '--json')).code).toBe(2);
    const missing = await run(join(dir, 'missing.jsonl'), '--json');
    expect(missing.code).toBe(1);
    expect(missing.body['ok']).toBe(false);
    expect(await cmdFleetIntentImport([])).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  });
});
