import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIntentMergeBatch } from '../src/cli/fleet-intent-merge-batch.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-14T13:00:00.000Z';
const directive: IntentItem = {
  id: 'recut', title: 'Recover CLI', source: 'fixture', owner: 'fixture', rq: ['RQ-CLI-C341'],
  prs: [], status: 'queued', evidence: [], provenance: [], partial: false, closureProposal: null,
  lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
};
const pull = { repo: 'example/project', number: 7, title: 'RQ-CLI-C341' };
let root: string;
let input: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cli-recut-c341-'));
  input = join(root, 'pulls.json');
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await writeLedger({ ...emptyLedger(), items: [structuredClone(directive)] }, root);
  await writeFile(input, JSON.stringify([pull, { ...pull, number: 8 }]));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('CLI recut of #4437', () => {
  it('is reachable through the fleet registry and previews unique matches without writing', async () => {
    const before = await readFile(intentLedgerPath(root), 'utf8');
    const module = await FLEET_SUBCOMMAND_LOADERS['intent-merge-batch']!();
    expect(module['cmdFleetIntentMergeBatch']).toBe(cmdFleetIntentMergeBatch);
    expect(await cmdFleetIntentMergeBatch(['--input', input, '--json'])).toBe(0);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])))
      .toEqual({ dryRun: true, applied: false, updated: 1 });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
  });

  it('applies explicit evidence and reports the distinct directive count', async () => {
    expect(await cmdFleetIntentMergeBatch(['--input', input, '--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])))
      .toEqual({ dryRun: false, applied: true, updated: 1 });
    const row = (await readLedger(root)).items[0]!;
    expect(row.status).toBe('merged');
    expect(row.prs.map((pr) => pr.number)).toEqual([7, 8]);
    expect(row.evidence.every((evidence) => evidence.kind === 'pr')).toBe(true);
  });

  it.each([
    ['unknown metadata', JSON.stringify([pull, { ...pull, extra: true }])],
    ['too many pulls', JSON.stringify(Array.from({ length: 1001 }, () => pull))],
    ['oversized input', ' '.repeat(1024 * 1024 + 1)],
  ])('refuses %s before any persisted update', async (_name, body) => {
    const before = await readFile(intentLedgerPath(root), 'utf8');
    await writeFile(input, body);
    expect(await cmdFleetIntentMergeBatch(['--input', input, '--apply'])).toBe(1);
    expect(console.error).toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
  });

  it('reports argument errors and help with their documented exit codes', async () => {
    expect(await cmdFleetIntentMergeBatch(['--apply'])).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('input is required'));
    expect(await cmdFleetIntentMergeBatch(['--help'])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('intent-merge-batch --input'));
  });
});
