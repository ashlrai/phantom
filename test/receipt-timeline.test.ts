import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { emitReceiptForDispatchEvent } from '../src/core/receipt/receipt-dispatch.js';
import { buildReceiptTimeline, formatReceiptTimeline } from '../src/core/receipt/receipt-timeline.js';
import { receiptsDir } from '../src/core/receipt/receipt-store.js';
import { custodyLedgerPath, readCustodyWindow } from '../src/core/run/custody-ledger.js';
import { checkReceiptVerify } from '../src/core/doctor.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-receipt-timeline-')); process.env.HOME = tmpHome; });
afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); process.env.HOME = origHome; });

const ev = (over: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent => ({
  schemaVersion: 1, ts: '2026-10-25T06:30:00.000Z', itemId: 'item-1', source: 'backlog' as DispatchProductionEvent['source'],
  repo: 'ashlrai/phantom', title: 'Secret title FAKE_TOKEN_abc123', backend: 'codex' as DispatchProductionEvent['backend'], tier: null,
  assignedBy: 'router', routeReason: 'free text', outcome: 'proposal-created', proposalCreated: true,
  runId: 'run-tl-1', spentUsd: 0.1, diffFiles: 3, diffLines: 40, reason: 'more free text', basis: 'live' as DispatchProductionEvent['basis'],
  ...over,
});

function ledger(lines: object[]): void {
  fs.mkdirSync(path.dirname(custodyLedgerPath()), { recursive: true });
  fs.writeFileSync(custodyLedgerPath(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('phm receipt timeline', () => {
  it('shows a verified receipt and the custody spawns in its window, value-free', () => {
    expect(emitReceiptForDispatchEvent(ev(), { ASHLR_RUN_RECEIPTS: '1' }).ok).toBe(true);
    const r = JSON.parse(fs.readFileSync(path.join(receiptsDir(), 'run-tl-1.json'), 'utf8'));
    const created = Date.parse(r.created_at);
    const iso = (ms: number) => new Date(ms).toISOString();
    ledger([
      { schema: 1, at: iso(created - 10_000), wrapped: true, engine: 'codex', preflight_exit: 0 },
      { schema: 1, at: iso(created - 5_000), wrapped: false, reason: 'not-initialized', engine: 'aider', preflight_exit: null },
      { schema: 1, at: iso(created + 3_600_000), wrapped: true, engine: 'codex', preflight_exit: 0 },
      'not json',
    ]);
    const t = buildReceiptTimeline('run-tl-1');
    expect(t).toMatchObject({ found: true, verified: true, execution: 'producer-succeeded', change: { filesTouched: 3, lines: 40 } });
    if (!t.found) throw new Error('unreachable');
    expect(t.spawns).toMatchObject({ total: 2, wrapped: 1, unwrapped: 1, malformed: 1 });
    expect(t.window.attribution).toBe('window');
    const text = formatReceiptTimeline(t) + JSON.stringify(t);
    expect(formatReceiptTimeline(t)).toContain('receipt run-tl-1: verified');
    expect(formatReceiptTimeline(t)).toContain('unwrapped (not-initialized)');
    for (const s of ['Secret title', 'FAKE_TOKEN', 'free text', 'item-1', 'ashlrai/phantom', tmpHome]) expect(text).not.toContain(s);
  });

  it('a missing or tampered receipt is reported as not verified and shows nothing else', () => {
    expect(buildReceiptTimeline('nope')).toEqual({ runId: 'nope', found: false, verified: false, reason: 'missing' });
    expect(emitReceiptForDispatchEvent(ev(), { ASHLR_RUN_RECEIPTS: '1' }).ok).toBe(true);
    const p = path.join(receiptsDir(), 'run-tl-1.json');
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    r.change.lines = 41;
    fs.writeFileSync(p, JSON.stringify(r));
    const t = buildReceiptTimeline('run-tl-1');
    expect(t.found).toBe(false);
    expect(formatReceiptTimeline(t)).toMatch(/^receipt run-tl-1: NOT verified \(/);
  });

  it('custody window reader filters by time and sanitizes engine names', () => {
    const text = [
      JSON.stringify({ schema: 1, at: '2026-10-25T06:00:00.000Z', wrapped: true, engine: '../etc/x', preflight_exit: 0 }),
      JSON.stringify({ schema: 1, at: '2026-10-25T08:00:00.000Z', wrapped: true, engine: 'codex', preflight_exit: 0 }),
    ].join('\n');
    const w = readCustodyWindow(new Date('2026-10-25T05:59:00Z'), new Date('2026-10-25T06:01:00Z'), text);
    expect(w).toEqual({ entries: [{ at: '2026-10-25T06:00:00.000Z', wrapped: true, reason: null, engine: 'unknown' }], malformed: 0 });
  });

  it('doctor warns only when the newest receipt fails to verify', () => {
    expect(checkReceiptVerify({ status: () => ({ receipts: 0, latest: null }) }).status).toBe('pass');
    expect(checkReceiptVerify({ status: () => ({ receipts: 2, latest: { runId: 'r2', verified: true, reason: null } }) }).status).toBe('pass');
    const w = checkReceiptVerify({ status: () => ({ receipts: 2, latest: { runId: 'r2', verified: false, reason: 'signature-invalid' } }) });
    expect(w.status).toBe('warn');
    expect(JSON.stringify(w)).toContain('signature-invalid');
    expect(checkReceiptVerify({ status: () => { throw new Error('x'); } }).status).toBe('warn');
  });
});
