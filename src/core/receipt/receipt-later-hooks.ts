/**
 * receipt.v1 R6 wiring: turn authority-ledger events the fleet already writes
 * into signed later[] entries on the matching run receipt.
 *
 *   gate:result G7 pass|refuse -> ci       (PR required checks settled)
 *   merge:landed (kind merge)  -> merge
 *   post-merge:result          -> survival (post-merge watch verdict)
 *   revert:landed              -> revert
 *
 * Best-effort and value-free: never throws, never blocks the ledger write
 * (it runs after the ledger lock is released), and skips quietly when the run
 * has no receipt. Only oids, PR numbers, verdicts and timestamps are copied;
 * free-text fields (reason, detail, code) never are. The same event seen twice
 * yields one entry (dedupe on the entry's identifying fields); a concurrent
 * double append loses cleanly with `conflict`.
 */
import { existsSync } from 'node:fs';
import { loadProposal } from '../inbox/store.js';
import type { LedgerEntryOf, LedgerEventKind } from '../authority/types.js';
import { appendReceiptLater, listReceiptRunIds, readReceiptV1, receiptsDir, type AppendLaterResult } from './receipt-store.js';
import type { ReceiptLaterEntry, ReceiptLaterKind } from './receipt-later.js';

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** How many recent receipts to scan when an event names a merge sha, not a proposal. */
export const RECEIPT_SCAN_LIMIT = 500;

type AnyEntry = { kind: LedgerEventKind | string; data: unknown };
export type LaterHookResult =
  | { kind: ReceiptLaterKind; runId: string; result: AppendLaterResult | { ok: false; reason: 'duplicate' } }
  | { skipped: 'not-relevant' | 'no-receipts' | 'no-run' | 'error' };

export interface LaterHookDeps {
  runIdForProposal?: (proposalId: string) => string | null;
  append?: typeof appendReceiptLater;
  now?: () => Date;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function defaultRunIdForProposal(proposalId: string): string | null {
  const p = loadProposal(proposalId);
  const runId = p?.runId;
  return typeof runId === 'string' && RUN_ID.test(runId) ? runId : null;
}

/** Run whose receipt carries a merge entry for this sha (full or 12+ hex prefix). Newest receipts first, bounded. */
export function runIdForMergeSha(sha: string, limit = RECEIPT_SCAN_LIMIT): { runId: string; mergeOid: string } | null {
  if (!/^[0-9a-f]{12,64}$/.test(sha)) return null;
  for (const runId of listReceiptRunIds(limit)) {
    const r = readReceiptV1(runId);
    if (!r.ok) continue;
    for (const e of r.later ?? []) {
      const m = e.kind === 'merge' ? (e.data as { merge_oid: string | null }).merge_oid : null;
      if (m && m.startsWith(sha)) return { runId, mergeOid: m };
    }
  }
  return null;
}

function sameEvent(existing: readonly ReceiptLaterEntry[], kind: ReceiptLaterKind, data: Record<string, unknown>): boolean {
  const keys: Record<ReceiptLaterKind, string[]> = {
    ci: ['head_oid', 'conclusion'],
    merge: ['merge_oid'],
    survival: ['merge_oid', 'checked_at'],
    revert: ['revert_oid'],
  };
  return existing.some((e) => e.kind === kind && keys[kind].every((k) => (e.data as unknown as Record<string, unknown>)[k] === (data[k] ?? null)));
}

/** Map one ledger entry to a later[] append. Exported for tests; never throws. */
export function receiptLaterFromLedgerEntry(entry: AnyEntry, deps: LaterHookDeps = {}): LaterHookResult {
  try {
    if (!['gate:result', 'merge:landed', 'post-merge:result', 'revert:landed'].includes(entry.kind)) return { skipped: 'not-relevant' };
    if (!existsSync(receiptsDir())) return { skipped: 'no-receipts' };
    const d = rec(entry.data);
    const toRun = deps.runIdForProposal ?? defaultRunIdForProposal;
    let runId: string | null = null;
    let kind: ReceiptLaterKind;
    let data: Record<string, unknown>;
    if (entry.kind === 'gate:result') {
      if (d['gate'] !== 'G7' || (d['verdict'] !== 'pass' && d['verdict'] !== 'refuse')) return { skipped: 'not-relevant' };
      const pid = s(d['proposalId']);
      runId = pid ? toRun(pid) : null;
      kind = 'ci';
      data = { head_oid: d['headSha'], conclusion: d['verdict'] === 'pass' ? 'success' : 'failure', completed_at: d['at'] };
    } else if (entry.kind === 'merge:landed') {
      if (d['kind'] !== 'merge') return { skipped: 'not-relevant' };
      const pid = s(d['proposalId']);
      runId = pid ? toRun(pid) : null;
      kind = 'merge';
      // Fleet landings are squash merges of the fleet PR (fleet-types LandingRecord).
      data = { merge_oid: d['mergeSha'], pr_number: d['prNumber'], method: 'squash', merged_at: d['landedAt'] };
    } else if (entry.kind === 'post-merge:result') {
      const sha = s(d['mergeSha']);
      const hit = sha && OID.test(sha) ? runIdForMergeSha(sha) : null;
      runId = hit?.runId ?? null;
      kind = 'survival';
      data = { merge_oid: hit?.mergeOid ?? null, reverted: d['verdict'] === 'green' ? false : null, checked_at: d['checkedAt'] };
    } else {
      // Landing ids are `${repo}#${prNumber}@${mergeSha.slice(0, 12)}` (host-merge.ts).
      const m = /@([0-9a-f]{12})$/.exec(s(d['revertsLandingId']) ?? '');
      const hit = m ? runIdForMergeSha(m[1]!) : null;
      runId = hit?.runId ?? null;
      kind = 'revert';
      data = { revert_oid: d['mergeSha'], reverted_oid: hit?.mergeOid ?? null, reverted_at: d['landedAt'] };
    }
    if (!runId) return { skipped: 'no-run' };
    const r = readReceiptV1(runId);
    if (!r.ok) return { skipped: 'no-run' };
    if (sameEvent(r.later ?? [], kind, data)) return { kind, runId, result: { ok: false, reason: 'duplicate' } };
    const result = (deps.append ?? appendReceiptLater)(runId, kind, data as never, deps.now?.());
    return { kind, runId, result };
  } catch {
    return { skipped: 'error' };
  }
}

/** Ledger append observer: best-effort, value-free warning only on a real write failure. */
export function observeLedgerEntriesForReceipts(entries: readonly LedgerEntryOf<LedgerEventKind>[]): void {
  for (const e of entries) {
    const out = receiptLaterFromLedgerEntry(e as AnyEntry);
    if ('result' in out && !out.result.ok && out.result.reason !== 'duplicate' && out.result.reason !== 'conflict') {
      console.warn('[ashlr] receipt later entry not written', out.kind, out.result.reason);
    }
  }
}

let unregister: (() => void) | null = null;
/** Idempotent: wire the observer into the authority ledger for this process. */
export function installReceiptLaterHooks(register: (fn: (entries: readonly LedgerEntryOf<LedgerEventKind>[]) => void) => () => void): () => void {
  if (!unregister) unregister = register(observeLedgerEntriesForReceipts);
  return () => { unregister?.(); unregister = null; };
}
