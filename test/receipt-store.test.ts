import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitReceiptV1, listReceiptRunIds, readReceiptV1, receiptStatus, receiptsDir } from '../src/core/receipt/receipt-store.js';
import { injectedNamesSummary, type ReceiptV1Body } from '../src/core/receipt/receipt-v1.js';
import { cmdFleetReceipt } from '../src/cli/receipt.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-receipt-store-')); process.env.HOME = tmpHome; });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmpHome, { recursive: true, force: true }); process.env.HOME = origHome; });

function body(runId: string): ReceiptV1Body {
  const names = injectedNamesSummary([`FAKE_${Date.now()}`]);
  return {
    schema: 'receipt.v1', run_id: runId, created_at: '2026-10-25T06:00:00Z', repo: 'ashlrai/phantom',
    base_oid: 'c'.repeat(40), head_oid: 'd'.repeat(40),
    identity: { engine: 'aider', seat: null, locus_pin_id: null, locus_observed: false },
    secrets: {
      initialized: true, status_schema: 1, wrap: { wrapped: false, reason: 'worktree-namespace' }, preflight: { verdict: null, exit: null },
      injected_names_count: names.count, injected_names_digest: names.digest,
      audit: { enabled: null, chain_verified: null, first_seq: null, last_seq: null },
    },
    spend: { tokens_in: null, tokens_out: null, acu: null, wall_ms: 10 },
    change: { diff_sha256: null, files_touched: 1, lines: 2, outside_grant_scope: [], grant_digest: null },
    approvals: [], efficiency: null, outcome: { execution: 'producer-succeeded' }, later: [],
  };
}

function capture(): () => string {
  let buf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { buf += String(c); return true; });
  return () => buf;
}

describe('receipt store', () => {
  it('emits once, reads back verified, refuses to overwrite', () => {
    const r = emitReceiptV1(body('run-a'));
    expect(r.ok).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(receiptsDir(), 'run-a.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(receiptsDir()).mode & 0o777).toBe(0o700);
    }
    expect(readReceiptV1('run-a').ok).toBe(true);
    expect(emitReceiptV1(body('run-a'))).toEqual({ ok: false, reason: 'exists' });
  });

  it('detects tampering on disk', () => {
    emitReceiptV1(body('run-b'));
    const p = path.join(receiptsDir(), 'run-b.json');
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    doc.change.lines = 999;
    fs.writeFileSync(p, JSON.stringify(doc));
    expect(readReceiptV1('run-b')).toEqual({ ok: false, reason: 'signature-invalid' });
    expect(receiptStatus().latest).toEqual({ runId: 'run-b', verified: false, reason: 'signature-invalid' });
  });

  it('rejects path-like run ids and reports missing receipts', () => {
    expect(readReceiptV1('../x')).toEqual({ ok: false, reason: 'run-id-invalid' });
    expect(emitReceiptV1(body('..'))).toEqual({ ok: false, reason: 'body-invalid' });
    expect(readReceiptV1('nope')).toEqual({ ok: false, reason: 'missing' });
  });

  it('status is read-only and never creates the key', () => {
    expect(receiptStatus()).toEqual({ keyPresent: false, keyId: null, receipts: 0, latest: null });
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'foundry'))).toBe(false);
  });

  it('CLI: list, verify, show, status', async () => {
    emitReceiptV1(body('run-c'));
    let out = capture();
    expect(await cmdFleetReceipt(['list'])).toBe(0);
    expect(out()).toContain('run-c');
    vi.restoreAllMocks(); out = capture();
    expect(await cmdFleetReceipt(['verify', 'run-c', '--json'])).toBe(0);
    expect(JSON.parse(out()).verified).toBe(true);
    vi.restoreAllMocks(); out = capture();
    expect(await cmdFleetReceipt(['show', 'run-c'])).toBe(0);
    expect(JSON.parse(out()).run_id).toBe('run-c');
    vi.restoreAllMocks(); out = capture();
    expect(await cmdFleetReceipt(['status'])).toBe(0);
    expect(out()).toContain('latest: run-c verified');
    vi.restoreAllMocks(); capture();
    expect(await cmdFleetReceipt(['verify', 'missing-run'])).toBe(1);
    expect(listReceiptRunIds()).toEqual(['run-c']);
  });
});
