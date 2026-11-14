import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetIntentMergeBatch } from '../src/cli/fleet-intent-merge-batch.js';
import { noteMergedPulls } from '../src/core/intent/merge.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-05T21:46:00.000Z';
const item = (id: string, status: IntentItem['status'] = 'queued'): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [], partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});
const pulls = [
  { repo: 'example/project', number: 1, title: 'RQ-ALPHA-1', branch: 'fix/RQ-BETA-1' },
  { repo: 'example/project', number: 2, title: 'RQ-ALPHA-1' },
];
let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  vi.useRealTimers(); vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-batch-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  vi.useFakeTimers(); vi.setSystemTime(new Date(at));
  await writeLedger({ ...emptyLedger(), items: [item('alpha'), item('beta', 'verified'), item('gamma', 'closed'), item('delta')] }, root);
}

describe('retained merge batch', () => {
  it('counts unique directives across title and branch matches and preserves other statuses', async () => {
    await setup();
    expect(await noteMergedPulls([...pulls, { repo: 'bad', number: 3, title: 'RQ-DELTA-1' }, { repo: 'example/project', number: 4, title: 'RQ-GAMMA-1' }], { root, now: at })).toEqual({ updated: 3 });
    const ledger = await readLedger(root);
    expect(ledger.items.map((row) => row.status)).toEqual(['merged', 'verified', 'closed', 'queued']);
    expect(ledger.items[0]!.prs.map((row) => row.number)).toEqual([1, 2]);
    expect(ledger.items[1]!.evidence[0]).toEqual({ at, kind: 'pr', ref: 'example/project#1' });
  });
  it('does not write for empty, unmatched, or partially invalid batches', async () => {
    await setup();
    const before = await readFile(intentLedgerPath(root), 'utf8');
    expect(await noteMergedPulls([], { root, now: at })).toEqual({ updated: 0 });
    expect(await noteMergedPulls([{ repo: 'example/project', number: 3, title: 'nothing' }], { root, now: at })).toEqual({ updated: 0 });
    await expect(noteMergedPulls([...pulls, { repo: 'example/project', number: 0, title: 'RQ-ALPHA-1' }], { root, now: at })).rejects.toThrow();
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
  });
  it('previews and applies the batch, rejecting malformed input and state', async () => {
    await setup();
    const input = join(root, 'pulls.json');
    await writeFile(input, JSON.stringify(pulls));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await readFile(intentLedgerPath(root), 'utf8');
    expect(await cmdFleetIntentMergeBatch(['--input', input, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ dryRun: true, applied: false, updated: 2 });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
    await writeFile(input, JSON.stringify([...pulls, { repo: 'bad', number: 1, title: 'bad' }]));
    expect(await cmdFleetIntentMergeBatch(['--input', input, '--apply'])).toBe(1);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
    await writeFile(input, JSON.stringify(pulls));
    expect(await cmdFleetIntentMergeBatch(['--input', input, '--apply', '--json'])).toBe(0);
    expect((await readLedger(root)).items[0]!.prs).toHaveLength(2);
    await writeFile(intentLedgerPath(root), '{');
    expect(await cmdFleetIntentMergeBatch(['--input', input, '--apply'])).toBe(1);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe('{');
    expect(await cmdFleetIntentMergeBatch(['--input', join(root, 'missing')])).toBe(1);
  });
});
