import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteMergedPulls } from '../src/core/intent/merge.js';
import { listIntents } from '../src/core/intent/read.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-05T21:46:00.000Z';
const item = (id: string, status: IntentItem['status'] = 'queued'): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [], partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });
async function setup(items: IntentItem[]): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-merge-'));
  await writeLedger({ ...emptyLedger(), items }, root);
}

describe('noteMergedPulls', () => {
  it('persists unique matches, associations, terminal statuses and unrelated rows', async () => {
    const untouched = item('other');
    await setup([item('alpha'), item('beta', 'verified'), item('gamma', 'closed'), item('delta', 'superseded'), item('epsilon', 'shipped'), untouched]);
    const pulls = [
      { repo: 'Org/Repo', number: 1, title: 'RQ-ALPHA-1 RQ-BETA-1 RQ-GAMMA-1' },
      { repo: 'org/repo', number: 2, title: 'RQ-ALPHA-1 RQ-DELTA-1 RQ-EPSILON-1' },
      { repo: 'org/repo', number: 1, title: 'RQ-ALPHA-1', url: 'https://example.com/1' },
    ];
    expect(await noteMergedPulls(pulls, { root, now: at })).toEqual({ updated: 5 });
    expect(await noteMergedPulls(pulls, { root, now: at })).toEqual({ updated: 5 });
    const rows = (await listIntents({ root })).items;
    expect(rows.map(row => row.status)).toEqual(['merged', 'verified', 'closed', 'superseded', 'shipped', 'queued']);
    expect(rows[0]!.prs).toEqual([
      { repo: 'Org/Repo', number: 1, state: 'merged', url: 'https://example.com/1' },
      { repo: 'org/repo', number: 2, state: 'merged' },
    ]);
    expect(rows[1]!.prs).toHaveLength(1);
    expect(rows[5]).toEqual(untouched);
    expect(rows[0]!.evidence).toHaveLength(6);
  });
  it('retains empty and invalid repository behavior without writing', async () => {
    root = await mkdtemp(join(tmpdir(), 'intent-merge-'));
    expect(await noteMergedPulls([], { root, now: 'invalid' })).toEqual({ updated: 0 });
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeLedger({ ...emptyLedger(), items: [item('alpha')] }, root);
    const before = await readFile(intentLedgerPath(root), 'utf8');
    expect(await noteMergedPulls([], { root, now: at })).toEqual({ updated: 0 });
    expect(await noteMergedPulls([{ repo: 'bad', number: 1, title: 'RQ-ALPHA-1' }], { root, now: at })).toEqual({ updated: 0 });
    await expect(noteMergedPulls([], { root, now: 'invalid' })).rejects.toThrow(/Time/);
    await expect(noteMergedPulls([{ repo: 'org/repo', number: 0, title: 'RQ-ALPHA-1' }], { root, now: at })).rejects.toThrow(/pull number/);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
  });
  it('does not persist earlier matches if a later pull is malformed', async () => {
    await setup([item('alpha')]);
    await expect(noteMergedPulls([
      { repo: 'org/repo', number: 1, title: 'RQ-ALPHA-1' },
      { repo: 'org/repo', number: 0, title: 'RQ-ALPHA-1' },
    ], { root, now: at })).rejects.toThrow();
    expect((await listIntents({ root })).items[0]).toEqual(item('alpha'));
  });
});
