import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIntentImport } from '../src/cli/fleet-intent-import.js';
import {
  INTENT_LEDGER_SCHEMA,
  type IntentItem,
  type IntentLedger,
  type IntentProvenance,
} from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger } from '../src/core/intent/store.js';

const at = '2026-10-01T00:00:00.000Z';
const touched = '2026-10-01T12:00:00.000Z';
let dir: string;
let previousRunsDir: string | undefined;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'intent-cli-prov-'));
  previousRunsDir = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = dir;
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { lines.push(String(line)); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRunsDir;
  await rm(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; body: Record<string, unknown> }> {
  const code = await cmdFleetIntentImport([...args, '--json']);
  return { code, body: JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown> };
}

const ledgerBytes = () => readFile(intentLedgerPath(dir), 'utf8');

function prov(partial: boolean): IntentProvenance {
  return { source: 'cli-copy', date: at, verbatim: true, partial };
}

function item(id: string, overrides: Partial<IntentItem> = {}): IntentItem {
  return {
    id,
    title: 'CLI provenance boundary',
    source: `src-${id}`,
    owner: 'owner',
    rq: ['RQ-CLI-PROV-290S'],
    prs: [],
    status: 'queued',
    evidence: [],
    provenance: [prov(true)],
    partial: true,
    closureProposal: null,
    lastTouchedAt: touched,
    staleAfterMs: 604800000,
    createdAt: touched,
    updatedAt: touched,
    ...overrides,
  };
}

async function writeNative(name: string, items: IntentItem[]): Promise<string> {
  const ledger: IntentLedger = { schema: INTENT_LEDGER_SCHEMA, items };
  const file = join(dir, name);
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
}

describe('fleet intent-import provenance boundary', () => {
  it('upgrades one provenance identity through the CLI without downgrading or replay drift', async () => {
    const partialFile = await writeNative('partial.json', [item('cli-prov-partial', {
      status: 'verified',
      closureProposal: 'superseded',
      prs: [{ repo: 'example/project', number: 290, url: 'https://example.test/pr/290', state: 'merged' }],
      evidence: [{ at: touched, kind: 'verification', ref: 'cli-check', note: 'passed' }],
    })]);
    const completeFile = await writeNative('complete.json', [item('cli-prov-complete', {
      status: 'merged',
      provenance: [prov(false)],
      partial: false,
      lastTouchedAt: at,
      createdAt: at,
      updatedAt: at,
    })]);

    const first = await run([partialFile]);
    expect(first.code).toBe(0);
    expect(first.body).toEqual({ ok: true, imported: 1, deduped: 0, items: 1 });

    const second = await run([completeFile]);
    expect(second.code).toBe(0);
    expect(second.body).toEqual({ ok: true, imported: 0, deduped: 1, items: 1 });

    const afterUpgrade = await ledgerBytes();
    const stored = (await readLedger(dir)).items;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: 'cli-prov-partial',
      status: 'verified',
      closureProposal: 'superseded',
      partial: true,
      rq: ['RQ-CLI-PROV-290S'],
      prs: [{ repo: 'example/project', number: 290, state: 'merged' }],
      evidence: [{ at: touched, kind: 'verification', ref: 'cli-check', note: 'passed' }],
      provenance: [prov(false)],
    });

    const partialAgain = await run([partialFile]);
    expect(partialAgain.code).toBe(0);
    expect(partialAgain.body).toEqual({ ok: true, imported: 0, deduped: 1, items: 1 });
    expect(await ledgerBytes()).toBe(afterUpgrade);
    expect((await readLedger(dir)).items[0]!.provenance).toEqual([prov(false)]);

    const replay = await run([partialFile, completeFile]);
    expect(replay.code).toBe(0);
    expect(replay.body).toEqual({ ok: true, imported: 0, deduped: 2, items: 1 });
    expect(await ledgerBytes()).toBe(afterUpgrade);
  });

  it('fails a malformed later batch file without touching ledger bytes, then a valid retry succeeds', async () => {
    const seed = join(dir, 'seed.jsonl');
    await writeFile(seed, `${JSON.stringify({
      id: 'cli-seed', title: 'Seed directive', source: 'seed-copy', owner: 'owner',
      rq: 'RQ-CLI-PROV-SEED', status: 'queued', date: at, verbatim: true,
    })}\n`);
    const seeded = await run([seed]);
    expect(seeded.code).toBe(0);
    expect(seeded.body).toEqual({ ok: true, imported: 1, deduped: 0, items: 1 });

    const before = await ledgerBytes();
    const good = join(dir, 'good.jsonl');
    await writeFile(good, `${JSON.stringify({
      id: 'cli-second', title: 'Second directive', source: 'second-copy', owner: 'owner',
      rq: 'RQ-CLI-PROV-SECOND', status: 'proposed', date: at, verbatim: true,
    })}\n`);
    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, 'this is not json\n');

    const failed = await run([good, bad]);
    expect(failed.code).toBe(1);
    expect(failed.body['ok']).toBe(false);
    expect(String(failed.body['error'])).toContain('bad.jsonl');
    expect(JSON.stringify(failed.body)).not.toContain('this is not json');
    expect(await ledgerBytes()).toBe(before);
    expect((await readLedger(dir)).items.map((row) => row.id)).toEqual(['cli-seed']);

    const retry = await run([good]);
    expect(retry.code).toBe(0);
    expect(retry.body).toEqual({ ok: true, imported: 1, deduped: 0, items: 2 });
    expect(await ledgerBytes()).not.toBe(before);
    expect((await readLedger(dir)).items.map((row) => row.id)).toEqual(['cli-seed', 'cli-second']);
  });
});
