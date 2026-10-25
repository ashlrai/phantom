import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { randomBytes } from 'node:crypto';
import { emitReceiptForDispatchEvent, localRepoName, ownerNameFromRemote, receiptBodyFromDispatchEvent, receiptRepoName } from '../src/core/receipt/receipt-dispatch.js';
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

describe('receipt repo name mapping', () => {
  const tok = () => randomBytes(16).toString('hex');
  it('parses https, ssh and scp-like GitHub remotes to owner/name', () => {
    expect(ownerNameFromRemote('https://github.com/ashlrai/phantom.git')).toBe('ashlrai/phantom');
    expect(ownerNameFromRemote('https://github.com/ashlrai/phantom')).toBe('ashlrai/phantom');
    expect(ownerNameFromRemote('git@github.com:ashlrai/phantom.git\n')).toBe('ashlrai/phantom');
    expect(ownerNameFromRemote('ssh://git@github.com/ashlrai/phantom.git')).toBe('ashlrai/phantom');
    expect(ownerNameFromRemote('ssh://git@github.com:22/ashlrai/phantom.git')).toBe('ashlrai/phantom');
  });
  it('strips userinfo so a token-bearing remote never leaks', () => {
    const t = tok();
    const out = ownerNameFromRemote(`https://x-access-token:${t}@github.com/acme/widget.git`)!;
    expect(out).toBe('acme/widget');
    expect(out).not.toContain(t);
  });
  it('returns null for non-GitHub or unparseable remotes', () => {
    expect(ownerNameFromRemote('https://gitlab.com/acme/widget.git')).toBeNull();
    expect(ownerNameFromRemote('https://github.com.evil.example/acme/widget')).toBeNull();
    expect(ownerNameFromRemote('/srv/git/widget.git')).toBeNull();
    expect(ownerNameFromRemote('https://github.com/acme/widget/extra')).toBeNull();
    expect(ownerNameFromRemote('')).toBeNull();
  });
  it('falls back to local/<sanitized folder> and never returns the full path', () => {
    expect(localRepoName('/home/u/work/my repo (copy)')).toBe('local/my-repo--copy-');
    expect(localRepoName('/tmp/x/')).toBe('local/x');
    expect(localRepoName('/')).toBe('local/repo');
    expect(localRepoName('/tmp/..')).toBe('local/repo');
    const t = tok();
    const viaGitlab = receiptRepoName(`/home/u/secret-${t}/proj`, () => `https://u:${t}@gitlab.com/a/b.git`)!;
    expect(viaGitlab).toBe('local/proj');
    expect(viaGitlab).not.toContain('/home');
    expect(receiptRepoName('/home/u/proj', () => null)).toBe('local/proj');
    expect(receiptRepoName('/home/u/proj', () => `https://u:${t}@github.com/acme/widget`)).toBe('acme/widget');
    expect(receiptRepoName('ashlrai/phantom', () => { throw new Error('not called'); })).toBe('ashlrai/phantom');
    expect(receiptRepoName('not a repo', () => null)).toBeNull();
  });
  it('maps an absolute-path dispatch event to a valid receipt body', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd name '));
    try {
      const b = receiptBodyFromDispatchEvent(ev({ repo: dir }))!;
      expect(b.repo).toMatch(/^local\/odd-name-/);
      expect(JSON.stringify(b)).not.toContain(os.tmpdir());
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('shadow rows and run-less events are not-applicable, not errors', () => {
    expect(emitReceiptForDispatchEvent(ev({ outcome: 'shadow-observation' }), { ASHLR_RUN_RECEIPTS: '1' })).toEqual({ ok: false, reason: 'not-applicable' });
    expect(emitReceiptForDispatchEvent(ev({ runId: undefined }), { ASHLR_RUN_RECEIPTS: '1' })).toEqual({ ok: false, reason: 'not-applicable' });
  });
});
