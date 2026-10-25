import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isReceiptLaterBody, normalizeLaterData, RECEIPT_LATER_SCHEMA, signReceiptLater, verifyReceiptLaterChain,
  type ReceiptLaterBody,
} from '../src/core/receipt/receipt-later.js';
import { appendReceiptLater, emitReceiptV1, readReceiptV1, receiptsDir } from '../src/core/receipt/receipt-store.js';
import { buildReceiptTimeline, formatReceiptTimeline } from '../src/core/receipt/receipt-timeline.js';
import type { ReceiptV1Body } from '../src/core/receipt/receipt-v1.js';
import { cmdFleetReceipt } from '../src/cli/receipt.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-receipt-later-')); process.env.HOME = tmpHome; });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmpHome, { recursive: true, force: true }); process.env.HOME = origHome; });

const hex = (n: number): string => randomBytes(n).toString('hex');
const OID = (): string => hex(20);

function body(runId: string): ReceiptV1Body {
  return {
    schema: 'receipt.v1', run_id: runId, created_at: '2026-10-25T06:00:00Z', repo: 'ashlrai/phantom',
    base_oid: null, head_oid: null,
    identity: { engine: 'aider', seat: null, locus_pin_id: null, locus_observed: false },
    secrets: {
      initialized: null, status_schema: null, wrap: null, preflight: { verdict: null, exit: null },
      injected_names_count: null, injected_names_digest: null,
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
const laterFile = (run: string, seq: number): string => path.join(receiptsDir(), `${run}.later`, `${String(seq).padStart(2, '0')}.json`);

describe('later[] pure core', () => {
  const k = generateKeyPairSync('ed25519');
  const parent = hex(32);
  const ci = (over: Partial<ReceiptLaterBody> = {}): ReceiptLaterBody => ({
    schema: RECEIPT_LATER_SCHEMA, run_id: 'r1', seq: 0, kind: 'ci', at: '2026-10-25T07:00:00.000Z', parent,
    data: normalizeLaterData('ci', { conclusion: 'success', checks_total: 5, checks_failed: 0 }), ...over,
  });

  it('normalizes unknown or invalid values to null for every kind', () => {
    expect(normalizeLaterData('ci', {})).toEqual({ head_oid: null, conclusion: null, checks_total: null, checks_failed: null, completed_at: null });
    expect(normalizeLaterData('merge', { method: 'force', pr_number: -1, merge_oid: 'not-an-oid' })).toEqual({ merge_oid: null, pr_number: null, method: null, merged_at: null });
    expect(normalizeLaterData('survival', { reverted: 'no' })).toEqual({ merge_oid: null, window_hours: null, reverted: null, checked_at: null });
    expect(normalizeLaterData('revert', { reverted_at: 'yesterday' })).toEqual({ revert_oid: null, reverted_oid: null, reverted_at: null });
    expect(normalizeLaterData('ci', { checks_total: 1, checks_failed: 3 }).checks_failed).toBeNull();
    // extra input keys never reach the data
    expect(Object.keys(normalizeLaterData('merge', { merge_oid: OID(), url: 'x', token: 'y' } as Record<string, unknown>))).toEqual(['merge_oid', 'pr_number', 'method', 'merged_at']);
  });

  it('rejects unknown keys, missing keys and wrong kinds (closed shape)', () => {
    expect(isReceiptLaterBody(ci())).toBe(true);
    expect(isReceiptLaterBody({ ...ci(), extra: 1 })).toBe(false);
    expect(isReceiptLaterBody({ ...ci(), data: { ...ci().data, url: 'x' } })).toBe(false);
    const { at: _at, ...missing } = ci();
    expect(isReceiptLaterBody(missing)).toBe(false);
    expect(isReceiptLaterBody({ ...ci(), kind: 'deploy' })).toBe(false);
    expect(isReceiptLaterBody({ ...ci(), kind: 'merge' })).toBe(false); // ci data under merge kind
    expect(isReceiptLaterBody({ ...ci(), seq: 64 })).toBe(false);
  });

  it('verifies a chain and detects edits, reorder, splice, gaps and foreign keys', () => {
    const e0 = signReceiptLater(ci(), k.privateKey, k.publicKey)!;
    const v0 = verifyReceiptLaterChain('r1', parent, [e0], k.publicKey);
    expect(v0.ok).toBe(true);
    const head = (v0 as { head: string }).head;
    const e1 = signReceiptLater({ ...ci(), seq: 1, kind: 'merge', parent: head, data: normalizeLaterData('merge', { merge_oid: OID(), method: 'squash' }) }, k.privateKey, k.publicKey)!;
    expect(verifyReceiptLaterChain('r1', parent, [e0, e1], k.publicKey).ok).toBe(true);

    const edited = { ...e0, data: { ...e0.data, conclusion: 'failure' } };
    expect(verifyReceiptLaterChain('r1', parent, [edited, e1], k.publicKey)).toMatchObject({ ok: false, reason: 'later-signature-invalid', index: 0 });
    expect(verifyReceiptLaterChain('r1', parent, [e1, e0], k.publicKey)).toMatchObject({ ok: false, reason: 'later-chain-broken' });
    expect(verifyReceiptLaterChain('r1', parent, [e1], k.publicKey)).toMatchObject({ ok: false, reason: 'later-chain-broken' });
    expect(verifyReceiptLaterChain('r2', parent, [e0], k.publicKey)).toMatchObject({ ok: false, reason: 'later-chain-broken' });
    expect(verifyReceiptLaterChain('r1', hex(32), [e0], k.publicKey)).toMatchObject({ ok: false, reason: 'later-chain-broken' });
    const other = generateKeyPairSync('ed25519');
    expect(verifyReceiptLaterChain('r1', parent, [e0], other.publicKey)).toMatchObject({ ok: false, reason: 'later-key-id-mismatch' });
    expect(verifyReceiptLaterChain('r1', parent, [{ ...e0, extra: true }], k.publicKey)).toMatchObject({ ok: false, reason: 'later-shape-invalid' });
  });
});

describe('later[] appenders on the store', () => {
  it('appends ci, merge, survival and revert; each verifies and the signed body is untouched', () => {
    expect(emitReceiptV1(body('run-l')).ok).toBe(true);
    const before = fs.readFileSync(path.join(receiptsDir(), 'run-l.json'), 'utf8');
    const head = OID(); const merge = OID(); const rev = OID();
    expect(appendReceiptLater('run-l', 'ci', { head_oid: head, conclusion: 'success', checks_total: 7, checks_failed: 0, completed_at: '2026-10-25T07:00:00Z' })).toMatchObject({ ok: true, seq: 0 });
    expect(appendReceiptLater('run-l', 'merge', { merge_oid: merge, pr_number: 910, method: 'squash', merged_at: '2026-10-25T07:10:00Z' })).toMatchObject({ ok: true, seq: 1 });
    expect(appendReceiptLater('run-l', 'survival', { merge_oid: merge, window_hours: 24 })).toMatchObject({ ok: true, seq: 2 });
    expect(appendReceiptLater('run-l', 'revert', { revert_oid: rev, reverted_oid: merge })).toMatchObject({ ok: true, seq: 3 });
    expect(fs.readFileSync(path.join(receiptsDir(), 'run-l.json'), 'utf8')).toBe(before);
    const r = readReceiptV1('run-l');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.later).toEqual([]);
    expect(r.later!.map((e) => e.kind)).toEqual(['ci', 'merge', 'survival', 'revert']);
    expect(r.later![2]!.data).toEqual({ merge_oid: merge, window_hours: 24, reverted: null, checked_at: null });
    expect(r.later![3]!.data).toMatchObject({ reverted_at: null });
    if (process.platform !== 'win32') {
      expect(fs.statSync(laterFile('run-l', 0)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(laterFile('run-l', 0))).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(path.dirname(laterFile('run-l', 0))).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    }
  });

  it('refuses to append without a verified receipt', () => {
    expect(appendReceiptLater('nope', 'ci', {})).toEqual({ ok: false, reason: 'receipt-not-verified' });
    expect(appendReceiptLater('../x', 'ci', {})).toEqual({ ok: false, reason: 'receipt-not-verified' });
  });

  it('detects tampering with a stored entry, a deleted middle entry and a symlinked entry', () => {
    emitReceiptV1(body('run-t'));
    appendReceiptLater('run-t', 'ci', { conclusion: 'success' });
    appendReceiptLater('run-t', 'merge', { method: 'squash' });
    appendReceiptLater('run-t', 'survival', { reverted: false });
    const f1 = laterFile('run-t', 1);
    const orig = fs.readFileSync(f1, 'utf8');
    fs.writeFileSync(f1, orig.replace('"squash"', '"rebase"'));
    expect(readReceiptV1('run-t')).toEqual({ ok: false, reason: 'later-signature-invalid' });
    expect(appendReceiptLater('run-t', 'revert', {})).toEqual({ ok: false, reason: 'receipt-not-verified' });
    fs.writeFileSync(f1, orig);
    expect(readReceiptV1('run-t').ok).toBe(true);
    fs.renameSync(f1, path.join(tmpHome, 'aside.json'));
    expect(readReceiptV1('run-t')).toEqual({ ok: false, reason: 'later-unreadable' });
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(tmpHome, 'aside.json'), f1);
      expect(readReceiptV1('run-t')).toEqual({ ok: false, reason: 'later-unreadable' });
    }
  });

  it('refuses a symlinked later directory and oversize entries', () => {
    if (process.platform === 'win32') return;
    emitReceiptV1(body('run-s'));
    const target = fs.mkdtempSync(path.join(tmpHome, 'elsewhere-'));
    fs.symlinkSync(target, path.join(receiptsDir(), 'run-s.later'));
    expect(appendReceiptLater('run-s', 'ci', {})).toEqual({ ok: false, reason: 'receipt-not-verified' });
    expect(fs.readdirSync(target)).toEqual([]);
    fs.unlinkSync(path.join(receiptsDir(), 'run-s.later'));
    appendReceiptLater('run-s', 'ci', {});
    fs.appendFileSync(laterFile('run-s', 0), ' '.repeat(9000));
    expect(readReceiptV1('run-s')).toEqual({ ok: false, reason: 'later-unreadable' });
  });

  it('leaks no planted values into entries, show, verify or timeline output', async () => {
    const fake = `sk_${hex(24)}`;
    const url = `https://u:${hex(12)}@github.com/acme/widget.git`;
    emitReceiptV1(body('run-k'));
    appendReceiptLater('run-k', 'ci', { head_oid: fake, conclusion: fake, completed_at: fake, url, token: fake } as Record<string, unknown>);
    appendReceiptLater('run-k', 'merge', { merge_oid: `${OID()}${fake}`, method: url, pr_number: 12 } as Record<string, unknown>);
    const files = fs.readdirSync(path.dirname(laterFile('run-k', 0))).map((n) => fs.readFileSync(path.join(path.dirname(laterFile('run-k', 0)), n), 'utf8')).join('\n');
    const got = capture();
    for (const sub of ['show', 'verify', 'timeline']) {
      await cmdFleetReceipt([sub, 'run-k']);
      await cmdFleetReceipt([sub, 'run-k', '--json']);
    }
    const all = files + got();
    for (const v of [fake, fake.slice(3), url, 'u:', tmpHome]) expect(all).not.toContain(v);
  });

  it('timeline and show list later entries; verify counts them', async () => {
    emitReceiptV1(body('run-v'));
    const merge = OID();
    appendReceiptLater('run-v', 'ci', { conclusion: 'success', checks_total: 4, checks_failed: 0 });
    appendReceiptLater('run-v', 'merge', { merge_oid: merge, pr_number: 42, method: 'squash' });
    const t = buildReceiptTimeline('run-v', { custody: () => ({ entries: [], malformed: 0 }) as never });
    expect(t.found && t.later.map((e) => [e.seq, e.kind])).toEqual([[0, 'ci'], [1, 'merge']]);
    const text = formatReceiptTimeline(t);
    expect(text).toContain('later    2 signed entries after close');
    expect(text).toMatch(/ci +success · head unknown · 0\/4 failed · completed unknown/);
    expect(text).toContain(`squash · merge ${merge.slice(0, 12)} · PR #42 · merged unknown`);
    const got = capture();
    expect(await cmdFleetReceipt(['show', 'run-v', '--json'])).toBe(0);
    expect(await cmdFleetReceipt(['verify', 'run-v', '--json'])).toBe(0);
    const [show, verify] = got().trim().split('\n').map((l) => JSON.parse(l));
    expect(show.later.map((e: { kind: string }) => e.kind)).toEqual(['ci', 'merge']);
    expect(show.sig).toBeDefined();
    expect(verify).toMatchObject({ verified: true, later: 2 });
  });
});
