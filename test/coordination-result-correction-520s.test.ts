import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as coordination from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const A = 'abcdef1234567890', B = '1234567890abcdef';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'correction-520s-'));
  dirs.push(dir);
  const options = { path: join(dir, 'coordination.jsonl'), now: 1000 };
  const owned = coordination.claimFleetWork({ repo: 'fake/project', task: 'original task', agent: 'agent-a' }, options);
  if (!owned.ok) throw new Error('fixture claim failed');
  const input = { id: owned.value.claim.id, agent: 'agent-a', lease: owned.value.lease, pr: 7 };
  const bytes = () => readFileSync(options.path, 'utf8');
  const events = () => bytes().trim().split('\n').map(line => JSON.parse(line) as {
    kind: string; message?: coordination.FleetMessage;
  });
  const view = () => projectCoordinationReturns(coordination.readFleetBoard({ ...options, reap: false }), options.now);
  const first = () => expect(returnFleetClaim({ ...input, head: A }, options).outcome).toBe('returned');
  return { options, input, bytes, events, view, first };
}
it('corrects through the public API after a restart and keeps one current result plus immutable history', async () => {
  const f = fixture(); f.first();
  const original = f.bytes();
  vi.resetModules();
  const fresh = await import('../src/core/fleet/coordination-return.js');
  const reader = await import('../src/core/fleet/coordination.js');
  f.options.now++;
  expect(fresh.returnFleetClaim({ ...f.input, head: B }, { ...f.options })).toMatchObject({ ok: true, outcome: 'returned' });
  expect(f.bytes().startsWith(original)).toBe(true);
  const posts = f.events().filter(e => e.kind === 'post');
  expect(posts).toHaveLength(2);
  expect(new Set(posts.map(e => e.message!.id)).size).toBe(2);
  expect(posts[0]!.message!.body).toContain(A);
  expect(posts[1]!.message!.body).toContain(B);
  expect(reader.readFleetBoard({ ...f.options }).messages).toHaveLength(1);
  expect(f.view()).toMatchObject({ unparsed: 0, returns: [{ claimId: f.input.id, head: B, repo: 'fake/project' }] });
  const settled = f.bytes();
  for (const head of [B, B, A]) expect(fresh.returnFleetClaim({ ...f.input, head }, { ...f.options }).outcome).toBe('already-returned');
  expect(f.bytes()).toBe(settled);
  expect(f.view().returns[0]?.head).toBe(B);
});
it('rejects wrong agents, leases, unrelated claims and a different PR without changing bytes or results', () => {
  const f = fixture(); f.first();
  const settled = f.bytes();
  for (const change of [{ agent: 'other' }, { lease: 'fake-wrong' }, { id: 'unrelated' }, { pr: 8 }]) {
    expect(returnFleetClaim({ ...f.input, head: B, ...change }, f.options).ok).toBe(false);
    expect(coordination.concludeFleetClaim({ ...f.input, ...change, correction: { pr: change.pr ?? 7, head: B } }, f.options).ok).toBe(false);
    expect(f.bytes()).toBe(settled);
  }
  expect(f.view().returns.map(r => r.head)).toEqual([A]);
});
it('uses original metadata and ignores arbitrary replacement messages on the correction API', () => {
  const f = fixture(); f.first(); f.options.now++;
  const intended = coordination.concludeFleetClaim({ ...f.input, correction: { pr: 7, head: B },
    message: { id: 'unrelated', from: 'sender-label', to: 'stranger', body: 'fake/replacement task' } }, f.options);
  expect(intended).toMatchObject({ ok: true, value: { outcome: 'intended', message: {
    from: 'agent-a', to: 'all', body: `RESULT VERIFIED fake/project claim ${f.input.id} task "original task": pr #7 head ${B}`,
  } } });
  expect(coordination.concludeFleetClaim(f.input, f.options)).toMatchObject({ ok: true, value: { outcome: 'resolved' } });
  expect(f.view().returns).toHaveLength(1);
  expect(f.view().returns[0]?.head).toBe(B);
});
it('preserves a corrected intent on publish failure and resolves exactly that intent on retry', () => {
  const f = fixture(); f.first(); f.options.now++;
  vi.spyOn(coordination, 'postFleetMessage').mockReturnValueOnce({ ok: false, error: 'unavailable' });
  const failed = returnFleetClaim({ ...f.input, head: B }, f.options);
  expect(failed).toMatchObject({ ok: false, outcome: 'released-unposted', body: expect.stringContaining(B) });
  expect(f.view().returns[0]?.head).toBe(A);
  const intents = f.events().filter(e => e.kind === 'return');
  expect(intents).toHaveLength(2);
  expect(intents[1]!.message!.id).toBe(failed.id);
  const before = f.bytes();
  expect(returnFleetClaim({ ...f.input, lease: 'wrong', head: B }, f.options).outcome).toBe('not-owner');
  expect(f.bytes()).toBe(before);
  expect(returnFleetClaim({ ...f.input, head: B }, { ...f.options }).outcome).toBe('returned');
  expect(f.events().filter(e => e.kind === 'return')).toHaveLength(2);
  expect(f.events().filter(e => e.kind === 'post')).toHaveLength(2);
  expect(f.view().returns.map(r => r.head)).toEqual([B]);
  vi.spyOn(coordination, 'postFleetMessage').mockReturnValueOnce({ ok: false, error: 'unavailable' });
  const headC = 'fedcba9876543210';
  expect(returnFleetClaim({ ...f.input, head: headC }, f.options).outcome).toBe('released-unposted');
  expect(f.view()).toMatchObject({ unparsed: 0, returns: [{ head: B }] });
  expect(returnFleetClaim({ ...f.input, head: headC }, f.options).outcome).toBe('returned');
  expect(f.view().returns.map(r => r.head)).toEqual([headC]);
});
it('fences expired original ownership and superseding work even after its release', () => {
  const expired = fixture(); expired.first(); expired.options.now += coordination.FLEET_CLAIM_TTL_MS;
  const before = expired.bytes();
  expect(returnFleetClaim({ ...expired.input, head: B }, expired.options).outcome).toBe('not-owner');
  expect(expired.bytes()).toBe(before);
  const f = fixture(); f.first();
  const successor = coordination.claimFleetWork({ repo: 'fake/project', task: 'original task', agent: 'agent-b' }, f.options);
  if (!successor.ok) throw new Error('successor failed');
  expect(coordination.releaseFleetClaim({ id: successor.value.claim.id, agent: 'agent-b', lease: successor.value.lease }, f.options).ok).toBe(true);
  const settled = f.bytes();
  expect(returnFleetClaim({ ...f.input, head: B }, f.options).outcome).toBe('not-owner');
  expect(f.bytes()).toBe(settled);
});
it('rejects the old lease after handoff and an expired live claim', () => {
  for (const mode of ['handoff', 'expiry']) {
    const f = fixture();
    if (mode === 'handoff') expect(coordination.handoffFleetClaim({ ...f.input, to: 'agent-b' }, f.options).ok).toBe(true);
    else { f.options.now += coordination.FLEET_CLAIM_TTL_MS; coordination.readFleetBoard(f.options); }
    const before = f.bytes();
    expect(returnFleetClaim({ ...f.input, head: B }, f.options).ok).toBe(false);
    expect(f.bytes()).toBe(before);
  }
});
it('retains correction fencing and prior posted receipts through journal compaction', () => {
  const f = fixture(); f.first();
  // Expired fake rows trigger the existing bounded compactor, without live state.
  const filler = JSON.stringify({ version: 1, kind: 'post', at: 0,
    message: { id: 'expired', from: 'fake', to: 'all', body: 'expired', at: 0, expiresAt: 1 } }) + '\n';
  appendFileSync(f.options.path, filler.repeat(16_000));
  expect(coordination.postFleetMessage({ from: 'fake', to: 'all', body: 'compaction trigger' }, f.options).ok).toBe(true);
  expect(f.events().length).toBeLessThan(10);
  expect(returnFleetClaim({ ...f.input, head: B }, f.options).outcome).toBe('returned');
  expect(f.events().filter(e => e.kind === 'post' && e.message!.body.includes('pr #7'))).toHaveLength(2);
  expect(f.view().returns.map(r => r.head)).toEqual([B]);
});
it('does not revive the previous head when a correction requests a shorter receipt lifetime', () => {
  const f = fixture(); f.first(); f.options.now++;
  const corrected = returnFleetClaim({ ...f.input, head: B, ttlMs: 1 }, f.options);
  expect(corrected).toMatchObject({ ok: true, outcome: 'returned' });
  f.options.now++;
  expect(coordination.postFleetMessage({ from: 'fake', to: 'all', body: 'fresh read mutation' }, f.options).ok).toBe(true);
  expect(f.view().returns.map(r => r.head)).toEqual([B]);
});
it('fails closed for legacy compacted intents without original claim metadata', () => {
  const f = fixture(); f.first();
  const history = f.events().filter(e => e.kind !== 'claim').map(e => {
    const { claim: _claim, ...legacy } = e as unknown as Record<string, unknown>;
    return JSON.stringify(legacy) + '\n';
  }).join('');
  // Represents an old compactor output that retained no original ownership window.
  rmSync(f.options.path);
  appendFileSync(f.options.path, history, { mode: 0o600 });
  const before = f.bytes();
  expect(returnFleetClaim({ ...f.input, head: B }, f.options).outcome).toBe('not-owner');
  expect(f.bytes()).toBe(before);
  expect(returnFleetClaim({ ...f.input, head: A }, f.options).outcome).toBe('already-returned');
});
