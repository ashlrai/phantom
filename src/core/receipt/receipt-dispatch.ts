/**
 * receipt.v1 at run close (slice R3b): build a receipt body from one recorded
 * daemon dispatch production event and emit it. Opt-in via
 * ASHLR_RUN_RECEIPTS=1 while it beds in. Never throws and never blocks the tick.
 *
 * Only fields the event actually carries are filled; everything else stays
 * null (base revision, custody wrap, tokens, approvals). The event's free-text
 * fields (title, reason, routeReason) are never copied.
 */
import { isCancelledDispatchProductionEvent, type DispatchProductionEvent } from '../fleet/dispatch-production-ledger.js';
import { emitReceiptV1, type EmitReceiptResult } from './receipt-store.js';
import { EXECUTION_OUTCOMES, isReceiptV1Body, RECEIPT_V1_SCHEMA, type ReceiptV1Body } from './receipt-v1.js';

type Execution = (typeof EXECUTION_OUTCOMES)[number];

function execution(event: DispatchProductionEvent): Execution {
  if (isCancelledDispatchProductionEvent(event)) return 'cancelled';
  switch (event.outcome) {
    case 'proposal-created': return 'producer-succeeded';
    case 'engine-failed':
    case 'sandbox-failed':
    case 'proposal-capture-error': return 'failed';
    case 'gate-blocked': return 'refused';
    case 'empty-diff': return 'empty-diff';
    case 'proposal-disabled': return 'disabled';
    default: return 'unknown';
  }
}

const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** Pure. Null when the event cannot produce a valid receipt (no run id, shadow rows, bad repo). */
export function receiptBodyFromDispatchEvent(event: DispatchProductionEvent): ReceiptV1Body | null {
  if (!event.runId || event.outcome === 'shadow-observation') return null;
  const createdAt = Date.parse(event.ts);
  if (!Number.isFinite(createdAt)) return null;
  const body: ReceiptV1Body = {
    schema: RECEIPT_V1_SCHEMA,
    run_id: event.runId,
    created_at: new Date(createdAt).toISOString(),
    repo: event.repo,
    base_oid: null,
    head_oid: null,
    identity: { engine: event.backend ?? 'unknown', seat: null, locus_pin_id: null, locus_observed: false },
    secrets: {
      initialized: null, status_schema: null, wrap: null, preflight: { verdict: null, exit: null },
      injected_names_count: null, injected_names_digest: null,
      audit: { enabled: null, chain_verified: null, first_seq: null, last_seq: null },
    },
    spend: { tokens_in: null, tokens_out: null, acu: null, wall_ms: 0 },
    change: { diff_sha256: null, files_touched: count(event.diffFiles), lines: count(event.diffLines), outside_grant_scope: [], grant_digest: null },
    approvals: [],
    efficiency: null,
    outcome: { execution: execution(event) },
    later: [],
  };
  return isReceiptV1Body(body) ? body : null;
}

export function runReceiptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ASHLR_RUN_RECEIPTS'] === '1';
}

/** Emit a receipt for a recorded event when enabled. Never throws. */
export function emitReceiptForDispatchEvent(
  event: DispatchProductionEvent,
  env: NodeJS.ProcessEnv = process.env,
): EmitReceiptResult | { ok: false; reason: 'disabled' | 'not-receiptable' } {
  try {
    if (!runReceiptsEnabled(env)) return { ok: false, reason: 'disabled' };
    const body = receiptBodyFromDispatchEvent(event);
    return body ? emitReceiptV1(body) : { ok: false, reason: 'not-receiptable' };
  } catch {
    return { ok: false, reason: 'not-receiptable' };
  }
}
