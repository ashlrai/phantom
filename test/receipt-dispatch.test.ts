import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { emitReceiptForDispatchEvent, receiptBodyFromDispatchEvent } from '../src/core/receipt/receipt-dispatch.js';
import { readReceiptV1 } from '../src/core/receipt/receipt-store.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-receipt-dispatch-')); process.env.HOME = tmpHome; });
afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); process.env.HOME = origHome; });

function ev(over: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  return {
    schemaVersion: 1, ts: '2026-10-25T06:30:00.000Z', itemId: 'item-1', source: 'backlog' as DispatchProductionEvent['source'],
    repo: 'ashlrai/phantom', title: 'Secret title FAKE_TOKEN_abc123', backend: 'codex' as DispatchProductionEvent['backend'], tier: null,
    assignedBy: 'router', routeReason: 'free text reason', outcome: 'proposal-created', proposalCreated: true,
    runId: 'run-dispatch-1', spentUsd: 0.1, diffFiles: 3, diffLines: 40, reason: 'more free text',
    basis: 'live' as DispatchProductionEvent['basis'],
    ...over,
  };
}

describe('receipt at run close', () => {
  it('maps a recorded event, copies no free text, leaves unknowns null', () => {
    const b = receiptBodyFromDispatchEvent(ev())!;
    expect(b.outcome.execution).toBe('producer-succeeded');
    expect(b.change).toMatchObject({ files_touched: 3, lines: 40 });
    expect(b.base_oid).toBeNull();
    expect(b.secrets.wrap).toBeNull();
    const text = JSON.stringify(b);
    for (const s of ['Secret title', 'FAKE_TOKEN', 'free text', 'item-1']) expect(text).not.toContain(s);
  });

  it('maps outcomes and skips shadow rows and events without a run id', () => {
    expect(receiptBodyFromDispatchEvent(ev({ outcome: 'engine-failed', proposalCreated: false }))!.outcome.execution).toBe('failed');
    expect(receiptBodyFromDispatchEvent(ev({ outcome: 'gate-blocked' }))!.outcome.execution).toBe('refused');
    expect(receiptBodyFromDispatchEvent(ev({ outcome: 'shadow-observation' }))).toBeNull();
    expect(receiptBodyFromDispatchEvent(ev({ runId: undefined }))).toBeNull();
    expect(receiptBodyFromDispatchEvent(ev({ repo: 'not a repo' }))).toBeNull();
  });

  it('is off unless ASHLR_RUN_RECEIPTS=1, and writes a verifiable receipt when on', () => {
    expect(emitReceiptForDispatchEvent(ev(), {})).toEqual({ ok: false, reason: 'disabled' });
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(false);
    const r = emitReceiptForDispatchEvent(ev(), { ASHLR_RUN_RECEIPTS: '1' });
    expect(r.ok).toBe(true);
    expect(readReceiptV1('run-dispatch-1').ok).toBe(true);
    expect(emitReceiptForDispatchEvent(ev(), { ASHLR_RUN_RECEIPTS: '1' })).toEqual({ ok: false, reason: 'exists' });
  });
});
