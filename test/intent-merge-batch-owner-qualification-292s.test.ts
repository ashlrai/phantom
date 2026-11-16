/**
 * RQ-PHX-INTENTBATCHOWNERQUALIFY292S — executable qualification for EXISTING
 * owner PR #5313 (RQ-PHX-INTENTMERGEBATCHRECOVER228S, head
 * cf324dd2f18876c10486b98beed316e9e10398bf). The owner adds
 * src/core/intent/merge.ts `noteMergedPulls`: one readLedger, per-pull
 * linkMergedPull matching, ONE final writeLedger. The owner recovery suite
 * (test/intent-merge-batch-recovery-228s.test.ts) already proves unique-match
 * counting, terminal-status preservation, malformed-batch byte stability and
 * the empty-pulls/no-ledger cases. This suite adds only the uncovered
 * combined persistence boundaries: DISTINCT batches accumulating across the
 * on-disk ledger, pre-existing provenance/evidence/prs surviving on matched
 * records, an invalid-repo skip ordered before a later malformed reject, and
 * an empty ledger refusing to write or invent evidence for non-empty pulls.
 * It self-skips on trees without the owner module (master before #5313
 * merges); merge tracking evidence never establishes shipped or verified.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MergedPullNote } from '../src/core/intent/evidence.js';
import { listIntents } from '../src/core/intent/read.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const OWNER_MODULE = existsSync(fileURLToPath(new URL('../src/core/intent/merge.ts', import.meta.url)));

type NoteMergedPulls = (pulls: MergedPullNote[], opts?: { root?: string; now?: string }) => Promise<{ updated: number }>;
async function noteMergedPulls(): Promise<NoteMergedPulls> {
  const mod = await import('../src/core/intent/merge.js') as { noteMergedPulls: NoteMergedPulls };
  return mod.noteMergedPulls;
}

const AT = '2026-11-13T12:00:00.000Z';
const LATER = '2026-11-13T13:00:00.000Z';
const provenance = { source: 'fixture', date: null, verbatim: true, partial: false };
const priorEvidence = { at: '2026-11-12T00:00:00.000Z', kind: 'note' as const, ref: 'seed-note' };
const priorPull = { repo: 'org/repo', number: 3, url: 'https://example.com/3', state: 'open' as const };

const item = (id: string, status: IntentStatus = 'queued', extra: Partial<IntentItem> = {}): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [], partial: false, closureProposal: null, lastTouchedAt: AT, staleAfterMs: 1000, createdAt: AT, updatedAt: AT,
  ...extra,
});

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });
async function setup(items: IntentItem[]): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-merge-owner-292-'));
  await writeLedger({ ...emptyLedger(), items }, root);
}
const ledgerBytes = () => readFile(intentLedgerPath(root), 'utf8');

describe.skipIf(!OWNER_MODULE)('noteMergedPulls owner qualification', () => {
  it('accumulates distinct batches on the persisted ledger and preserves prior record fields', async () => {
    const note = await noteMergedPulls();
    const alpha = item('alpha', 'queued', { provenance: [provenance], evidence: [priorEvidence], prs: [priorPull] });
    const beta = item('beta', 'verified', { provenance: [provenance] });
    const gamma = item('gamma', 'closed');
    const delta = item('delta', 'shipped');
    const other = item('other', 'queued', { provenance: [provenance] });
    await setup([alpha, beta, gamma, delta, other]);

    expect(await note([{ repo: 'Org/Repo', number: 7, title: 'RQ-ALPHA-1 RQ-BETA-1', url: 'https://example.com/7' }], { root, now: AT }))
      .toEqual({ updated: 2 });
    // A second, distinct batch re-reads the ledger from disk: case-varied and
    // duplicate pull associations still count each intent once.
    expect(await note([
      { repo: 'org/repo', number: 8, title: 'RQ-ALPHA-1 RQ-GAMMA-1 RQ-DELTA-1' },
      { repo: 'ORG/REPO', number: 8, title: 'RQ-ALPHA-1' },
      { repo: 'not a repo', number: 9, title: 'RQ-OTHER-1' },
    ], { root, now: LATER })).toEqual({ updated: 3 });

    const rows = (await listIntents({ root })).items;
    const [a, b, g, d, o] = rows as [IntentItem, IntentItem, IntentItem, IntentItem, IntentItem];
    expect(a.status).toBe('merged');
    expect(a.prs.map((pull) => `${pull.repo}#${pull.number}`)).toEqual(['org/repo#3', 'Org/Repo#7', 'org/repo#8']);
    expect(a.evidence.map((row) => `${row.kind}:${row.ref}`)).toEqual([
      'note:seed-note', 'pr:Org/Repo#7', 'pr:org/repo#8', 'pr:ORG/REPO#8',
    ]);
    expect(a.provenance).toEqual([provenance]);
    expect(b.status).toBe('verified');
    expect(g.status).toBe('closed');
    expect(d.status).toBe('shipped');
    expect(o).toEqual(other);
    // Merge tracking never mints shipped/verified truth: matched rows gain
    // only 'pr' evidence and open rows stop at 'merged'.
    for (const row of [a, b, g, d]) {
      expect(row.evidence.every((entry) => entry.kind !== 'release' && entry.kind !== 'verification')).toBe(true);
    }
    expect((await readLedger(root)).items).toHaveLength(5);
  });

  it('rejects a malformed later pull after an invalid-repo skip without touching disk bytes', async () => {
    const note = await noteMergedPulls();
    const alpha = item('alpha');
    const beta = item('beta', 'in-progress');
    await setup([alpha, beta]);
    const before = await ledgerBytes();
    await expect(note([
      { repo: 'org/repo', number: 1, title: 'RQ-ALPHA-1 RQ-BETA-1' },
      { repo: 'not a repo', number: 2, title: 'RQ-ALPHA-1' },
      { repo: 'org/repo', number: 0, title: 'RQ-ALPHA-1' },
    ], { root, now: AT })).rejects.toThrow(/pull number/);
    expect(await ledgerBytes()).toBe(before);
    expect((await listIntents({ root })).items).toEqual([alpha, beta]);
  });

  it('performs no write and invents no evidence for non-empty pulls on an empty ledger', async () => {
    const note = await noteMergedPulls();
    const pulls = [{ repo: 'org/repo', number: 1, title: 'RQ-ALPHA-1' }];
    root = await mkdtemp(join(tmpdir(), 'intent-merge-owner-292-'));
    // Absent ledger: the early return precedes even time validation.
    expect(await note(pulls, { root, now: 'not-a-time' })).toEqual({ updated: 0 });
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    // Present-but-empty ledger: valid pulls still cannot create evidence.
    await writeLedger({ ...emptyLedger(), items: [] }, root);
    const before = await ledgerBytes();
    expect(await note(pulls, { root, now: AT })).toEqual({ updated: 0 });
    expect(await ledgerBytes()).toBe(before);
    expect((await readLedger(root)).items).toEqual([]);
  });
});
