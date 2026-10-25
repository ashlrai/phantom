import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTOMERGE_CANARY_ENFORCE_SUPPORTED } from '../src/core/fleet/automerge-canary-store.js';
import { cancelHostAutoMerge, HOST_CANCELLATION_MAX_READS, type CancelView } from '../src/core/fleet/automerge-canary-cancel.js';
import type { PrView } from '../src/core/integrations/github.js';

const HEAD = 'a'.repeat(40);
const target = { repo: 'ashlrai/phantom', number: 42, expectedHeadOid: HEAD };
const open = (over: Partial<PrView> = {}): PrView => ({ state: 'OPEN', closed: false, mergedAt: null, headRefOid: HEAD, autoMergeRequest: { kind: 'absent' }, ...over });
const present: PrView['autoMergeRequest'] = { kind: 'present', request: { enabledAt: '2026-10-25T06:00:00Z', enabledByLogin: 'bot', mergeMethod: 'SQUASH' } };
const seq = (...views: Array<PrView | null | Error>): CancelView => { let i = 0; return () => { const v = views[Math.min(i++, views.length - 1)]; if (v instanceof Error) throw v; return v ?? null; }; };
const ok = () => ({ ok: true });

describe('canary host auto-merge cancellation proof (enforce stays off)', () => {
  it('sends exactly gh pr merge --disable-auto for the target before reading', () => {
    const calls: string[][] = [];
    const order: string[] = [];
    cancelHostAutoMerge(target, { exec: (a) => { calls.push([...a]); order.push('exec'); return { ok: true }; }, view: () => { order.push('view'); return open(); } });
    expect(calls).toEqual([['pr', 'merge', '42', '--repo', 'ashlrai/phantom', '--disable-auto']]);
    expect(order[0]).toBe('exec');
  });

  it('confirms only on positive evidence: open, same head, auto-merge absent, disable succeeded', () => {
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open()) })).toEqual({ outcome: 'cancelled-confirmed', reads: 1 });
  });

  it('eventual consistency: still-present auto-merge is re-read, then confirmed', () => {
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ autoMergeRequest: present }), open()) })).toEqual({ outcome: 'cancelled-confirmed', reads: 2 });
  });

  it('auto-merge still present after every read is not confirmed', () => {
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ autoMergeRequest: present })) }))
      .toEqual({ outcome: 'not-confirmed', reason: 'auto-merge-still-present', reads: HOST_CANCELLATION_MAX_READS });
  });

  it('unknown or malformed auto-merge state is never read as cancelled', () => {
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ autoMergeRequest: { kind: 'unknown', reason: 'missing' } })) }))
      .toMatchObject({ outcome: 'not-confirmed', reason: 'auto-merge-unknown' });
  });

  it('a failed or throwing disable is not confirmed even if auto-merge reads absent', () => {
    expect(cancelHostAutoMerge(target, { exec: () => ({ ok: false }), view: seq(open()) })).toMatchObject({ outcome: 'not-confirmed', reason: 'disable-failed' });
    expect(cancelHostAutoMerge(target, { exec: () => { throw new Error('gh missing'); }, view: seq(open()) })).toMatchObject({ outcome: 'not-confirmed', reason: 'disable-failed' });
  });

  it('host merged anyway (race) is reported as merged, never as cancelled', () => {
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ state: 'MERGED', mergedAt: '2026-10-25T06:01:00Z', mergeCommitOid: 'b'.repeat(40) })) }))
      .toEqual({ outcome: 'merged', mergeCommitOid: 'b'.repeat(40), reads: 1 });
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ autoMergeRequest: present }), open({ state: 'MERGED', mergedAt: '2026-10-25T06:01:00Z' })) }))
      .toMatchObject({ outcome: 'merged', reads: 2 });
  });

  it('a moved head is not confirmed (a new head could carry a new auto-merge)', () => {
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ headRefOid: 'c'.repeat(40) })) })).toMatchObject({ outcome: 'not-confirmed', reason: 'head-moved' });
  });

  it('unreadable views (null, throw, odd state) are not confirmed and the read count is bounded', () => {
    let n = 0;
    const r = cancelHostAutoMerge(target, { exec: ok, view: () => { n++; return null; }, maxReads: 50 });
    expect(r).toMatchObject({ outcome: 'not-confirmed', reason: 'view-unavailable' });
    expect(n).toBe(10);
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(new Error('boom')) })).toMatchObject({ outcome: 'not-confirmed', reason: 'view-unavailable' });
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ state: 'DRAFTISH' })) })).toMatchObject({ outcome: 'not-confirmed', reason: 'state-unknown' });
  });

  it('closed without merge is safe and distinct from cancelled', () => {
    expect(cancelHostAutoMerge(target, { exec: ok, view: seq(open({ state: 'CLOSED', closed: true })) })).toEqual({ outcome: 'closed-unmerged', reads: 1 });
  });

  it('enforce stays unsupported and nothing outside tests imports the primitive yet', () => {
    expect(AUTOMERGE_CANARY_ENFORCE_SUPPORTED).toBe(false);
    const cli = readFileSync(new URL('../src/cli/automerge-canary.ts', import.meta.url), 'utf8');
    expect(cli).toContain('hostCancellationProven: false');
    expect(cli).not.toContain('automerge-canary-cancel');
  });
});
