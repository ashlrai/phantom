import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLedger, registerLedgerAppendObserver } from '../src/core/authority/ledger.js';
import { emitReceiptV1, readReceiptV1, receiptsDir } from '../src/core/receipt/receipt-store.js';
import { observeLedgerEntriesForReceipts, receiptLaterFromLedgerEntry, runIdForMergeSha } from '../src/core/receipt/receipt-later-hooks.js';
import type { ReceiptV1Body } from '../src/core/receipt/receipt-v1.js';

const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-later-hooks-')); process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome; });
afterEach(() => {
  vi.restoreAllMocks(); fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome; if (origProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origProfile;
});

const OID = (): string => randomBytes(20).toString('hex');
const runs: Record<string, string> = { 'prop-1': 'run-h1' };
const deps = { runIdForProposal: (p: string) => runs[p] ?? null };
function body(runId: string): ReceiptV1Body {
  return {
    schema: 'receipt.v1', run_id: runId, created_at: '2026-10-25T06:00:00Z', repo: 'acme/widget', base_oid: null, head_oid: null,
    identity: { engine: 'aider', seat: null, locus_pin_id: null, locus_observed: false },
    secrets: { initialized: null, status_schema: null, wrap: null, preflight: { verdict: null, exit: null }, injected_names_count: null, injected_names_digest: null,
      audit: { enabled: null, chain_verified: null, first_seq: null, last_seq: null } },
    spend: { tokens_in: null, tokens_out: null, acu: null, wall_ms: 1 },
    change: { diff_sha256: null, files_touched: 1, lines: 1, outside_grant_scope: [], grant_digest: null },
    approvals: [], efficiency: null, outcome: { execution: 'producer-succeeded' }, later: [],
  };
}
const gate = (over: Record<string, unknown> = {}) => ({ kind: 'gate:result', data: { v: 1, gate: 'G7', proposalId: 'prop-1', repo: 'acme/widget', headSha: OID(), verdict: 'pass', code: 'checks-green', reason: 'r', at: '2026-10-25T07:00:00.000Z', digest: 'd', ...over } });
const merge = (mergeSha: string, over: Record<string, unknown> = {}) => ({ kind: 'merge:landed', data: { v: 1, id: `acme/widget#7@${mergeSha.slice(0, 12)}`, kind: 'merge', repo: 'acme/widget', prNumber: 7, headSha: OID(), mergeSha, proposalId: 'prop-1', revertsLandingId: null, landedAt: '2026-10-25T07:10:00.000Z', ...over } });
const later = (run = 'run-h1') => { const r = readReceiptV1(run); return r.ok ? r.later ?? [] : null; };

describe('receipt later[] hooks', () => {
  it('ci: G7 pass and refuse append; wait, owner-lane and other gates do not', () => {
    emitReceiptV1(body('run-h1'));
    const head = OID();
    expect(receiptLaterFromLedgerEntry(gate({ headSha: head }), deps)).toMatchObject({ kind: 'ci', runId: 'run-h1', result: { ok: true, seq: 0 } });
    expect(receiptLaterFromLedgerEntry(gate({ verdict: 'refuse' }), deps)).toMatchObject({ kind: 'ci', result: { ok: true, seq: 1 } });
    for (const g of [gate({ verdict: 'wait' }), gate({ verdict: 'owner-lane' }), gate({ gate: 'G3' })]) expect(receiptLaterFromLedgerEntry(g, deps)).toEqual({ skipped: 'not-relevant' });
    const l = later()!;
    expect(l[0]!.data).toEqual({ head_oid: head, conclusion: 'success', checks_total: null, checks_failed: null, completed_at: '2026-10-25T07:00:00.000Z' });
    expect((l[1]!.data as { conclusion: string }).conclusion).toBe('failure');
  });

  it('merge: merge:landed of kind merge appends; revert-kind landings are not merges', () => {
    emitReceiptV1(body('run-h1'));
    const sha = OID();
    expect(receiptLaterFromLedgerEntry(merge(sha), deps)).toMatchObject({ kind: 'merge', result: { ok: true } });
    expect(receiptLaterFromLedgerEntry(merge(OID(), { kind: 'revert' }), deps)).toEqual({ skipped: 'not-relevant' });
    expect(later()![0]!.data).toEqual({ merge_oid: sha, pr_number: 7, method: 'squash', merged_at: '2026-10-25T07:10:00.000Z' });
  });

  it('survival and revert find the run by its merge sha', () => {
    emitReceiptV1(body('run-h1'));
    emitReceiptV1(body('run-other'));
    const sha = OID(); const rev = OID();
    receiptLaterFromLedgerEntry(merge(sha), deps);
    expect(runIdForMergeSha(sha)).toEqual({ runId: 'run-h1', mergeOid: sha });
    expect(receiptLaterFromLedgerEntry({ kind: 'post-merge:result', data: { v: 1, landingId: 'x', repo: 'acme/widget', mergeSha: sha, ci: 'green', suite: 'pass', verdict: 'green', detail: 'd', checkedAt: '2026-10-25T09:10:00.000Z' } }, deps))
      .toMatchObject({ kind: 'survival', runId: 'run-h1', result: { ok: true } });
    expect(receiptLaterFromLedgerEntry({ kind: 'revert:landed', data: { v: 1, id: 'r', kind: 'revert', repo: 'acme/widget', prNumber: 8, mergeSha: rev, proposalId: null, revertsLandingId: `acme/widget#7@${sha.slice(0, 12)}`, landedAt: '2026-10-25T10:00:00.000Z' } }, deps))
      .toMatchObject({ kind: 'revert', runId: 'run-h1', result: { ok: true } });
    const l = later()!;
    expect(l.map((e) => e.kind)).toEqual(['merge', 'survival', 'revert']);
    expect(l[1]!.data).toEqual({ merge_oid: sha, window_hours: null, reverted: false, checked_at: '2026-10-25T09:10:00.000Z' });
    expect(l[2]!.data).toEqual({ revert_oid: rev, reverted_oid: sha, reverted_at: '2026-10-25T10:00:00.000Z' });
    expect(later('run-other')).toEqual([]);
    // red verdict: reverted is unknown (null) until a revert lands
    receiptLaterFromLedgerEntry({ kind: 'post-merge:result', data: { mergeSha: sha, verdict: 'red', checkedAt: '2026-10-25T09:20:00.000Z' } }, deps);
    expect((later()!.at(-1)!.data as { reverted: unknown }).reverted).toBeNull();
  });

  it('skips quietly with no receipts, an unknown proposal or an unmatched sha', () => {
    expect(receiptLaterFromLedgerEntry(gate(), deps)).toEqual({ skipped: 'no-receipts' });
    emitReceiptV1(body('run-h1'));
    expect(receiptLaterFromLedgerEntry(gate({ proposalId: 'nope' }), deps)).toEqual({ skipped: 'no-run' });
    expect(receiptLaterFromLedgerEntry({ kind: 'post-merge:result', data: { mergeSha: OID(), verdict: 'green' } }, deps)).toEqual({ skipped: 'no-run' });
    expect(receiptLaterFromLedgerEntry({ kind: 'revert:landed', data: { revertsLandingId: 'garbage' } }, deps)).toEqual({ skipped: 'no-run' });
    expect(receiptLaterFromLedgerEntry({ kind: 'pr:opened', data: {} }, deps)).toEqual({ skipped: 'not-relevant' });
    expect(receiptLaterFromLedgerEntry(gate(), { runIdForProposal: () => { throw new Error('boom'); } })).toEqual({ skipped: 'error' });
    expect(later()).toEqual([]);
  });

  it('is idempotent: the same event twice yields one entry', () => {
    emitReceiptV1(body('run-h1'));
    const sha = OID(); const g = gate();
    expect(receiptLaterFromLedgerEntry(merge(sha), deps)).toMatchObject({ result: { ok: true } });
    expect(receiptLaterFromLedgerEntry(merge(sha), deps)).toMatchObject({ kind: 'merge', result: { ok: false, reason: 'duplicate' } });
    receiptLaterFromLedgerEntry(g, deps);
    expect(receiptLaterFromLedgerEntry(g, deps)).toMatchObject({ result: { ok: false, reason: 'duplicate' } });
    expect(later()!.map((e) => e.kind)).toEqual(['merge', 'ci']);
    expect(readReceiptV1('run-h1').ok).toBe(true);
  });

  it('copies no free text or planted values', () => {
    emitReceiptV1(body('run-h1'));
    const fake = `sk_${randomBytes(20).toString('hex')}`;
    receiptLaterFromLedgerEntry(gate({ reason: fake, code: fake, digest: fake }), deps);
    receiptLaterFromLedgerEntry(merge(OID(), { id: fake, landedAt: fake }), deps);
    const files = fs.readdirSync(path.join(receiptsDir(), 'run-h1.later')).map((n) => fs.readFileSync(path.join(receiptsDir(), 'run-h1.later', n), 'utf8')).join('');
    expect(files).not.toContain(fake);
    expect(files).not.toContain(fake.slice(3));
  });

  it('observer warns value-free only on a real write failure', () => {
    emitReceiptV1(body('run-h1'));
    fs.mkdirSync(path.join(receiptsDir(), 'run-h1.later'), { mode: 0o700 });
    fs.writeFileSync(path.join(receiptsDir(), 'run-h1.later', 'stray'), 'x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    observeLedgerEntriesForReceipts([gate() as never]);
    // receipt fails verification (stray file), so the hook skips quietly rather than warning
    expect(warn).not.toHaveBeenCalled();
  });

  it('ledger seam: observers see appended rows after the lock and cannot break the append', () => {
    const seen: string[] = [];
    const off1 = registerLedgerAppendObserver((rows) => { seen.push(...rows.map((r) => r.kind)); });
    const off2 = registerLedgerAppendObserver(() => { throw new Error('observer bug'); });
    try {
      const r = appendLedger({ kind: 'pr:opened', actor: 'daemon', repo: 'acme/widget', grantId: null,
        data: { v: 1, repo: 'acme/widget', number: 7, proposalId: 'prop-1', branch: 'ashlr/fleet/prop-1', headSha: OID(), kind: 'change', ownerLane: false, at: '2026-10-25T07:00:00.000Z' } });
      expect(r.ok).toBe(true);
      expect(seen).toContain('pr:opened');
    } finally { off1(); off2(); }
  });
});
