import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimBusWorkJob, executeBusClaimBody, listBusClaims, type BusClaimResult } from '../src/core/agents/bus-claims.js';
import { acquireCoordination, listCoordination, teamClaimKey } from '../src/core/agents/claim-store.js';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';
import { handleAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = 1_800_000_000_000;
const TOKEN_RE = /^[a-f0-9]{64}$/;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const acquire = (claimKey: string, owner = 'dot-main', leaseMs = 600_000, opId = 'op-1', root = tempDir('v2claim-'), now = NOW) =>
  executeBusClaimBody({ kind: 'work.claim', op: 'acquire', claimKey, owner, leaseMs }, opId, { root, now });
const renew = (claimKey: string, token: string, leaseMs = 600_000, root?: string, now = NOW) =>
  executeBusClaimBody({ kind: 'work.claim', op: 'renew', claimKey, token, leaseMs }, 'op-renew', { root, now });
const release = (claimKey: string, token: string, outcome: 'released' | 'completed' = 'released', root?: string, now = NOW) =>
  executeBusClaimBody({ kind: 'work.release', claimKey, token, outcome }, 'op-release', { root, now });
const tokenOf = (result: BusClaimResult | undefined): string => {
  if (result?.status !== 'acquired') throw new Error(`expected acquired, got ${JSON.stringify(result)}`);
  return result.claim.token;
};

describe('executeBusClaimBody', () => {
  it('ignores non-claim bodies so opaque mail still appends', () => {
    const root = tempDir('v2claim-');
    for (const body of [
      { kind: 'note', text: 'hi' },
      { kind: 'work.post', jobId: 'J1', title: 't', repo: 'a/b', claimKeys: ['queue:J1'] },
      { kind: 'work.status', jobId: 'J1', status: 'running' },
      { kind: 'wake', target: 'x', reason: 'r' },
      { kind: 'bogus' }, 'plain', 42, null, [],
    ]) {
      expect(executeBusClaimBody(body, 'op-x', { root, now: NOW })).toBeUndefined();
    }
  });

  it('acquires a resource claim and lands it in the one coordination table', () => {
    const root = tempDir('v2claim-');
    const result = acquire('path:ashlrai/phantom:docs/**', 'dot-main', 600_000, 'op-1', root);
    expect(result).toMatchObject({ v: 2, status: 'acquired', claim: { claimKey: 'path:ashlrai/phantom:docs/**', owner: 'dot-main', leaseMs: 600_000, leaseUntil: NOW + 600_000 } });
    expect(tokenOf(result)).toMatch(TOKEN_RE);
    const listed = listCoordination(root, NOW);
    expect(listed.source).toBe('available');
    expect(listed.claims).toHaveLength(1);
    expect(listed.claims[0]).toMatchObject({ origin: 'resource', key: 'path:ashlrai/phantom:docs/**', owner: 'dot-main', live: true });
  });

  it('refuses an overlapping live claim with the holder and never the token', () => {
    const root = tempDir('v2claim-');
    const first = acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root);
    const token = tokenOf(first);
    const second = acquire('path:ashlrai/phantom:docs/**', 'other-seat', 600_000, 'op-2', root);
    expect(second).toEqual({ v: 2, status: 'conflict', holder: { owner: 'dot-main', claimKey: 'repo:ashlrai/phantom', leaseUntil: NOW + 600_000 } });
    expect(JSON.stringify(second)).not.toContain(token);
    // A different op id on the same key conflicts; the same op id retries cleanly.
    expect(acquire('repo:ashlrai/phantom', 'other-seat', 600_000, 'op-3', root)).toMatchObject({ status: 'conflict' });
    const retry = acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root);
    expect(retry).toMatchObject({ status: 'acquired' });
    expect(tokenOf(retry)).not.toBe(token);
  });

  it('binds a retried operation id to its owner instead of replacing a live lease', () => {
    const root = tempDir('v2claim-');
    const token = tokenOf(acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root));
    // A different owner reusing the operation id conflicts with the live holder —
    // never a silent replacement that kills dot-main's fencing token.
    const stolen = acquire('repo:ashlrai/phantom', 'other-seat', 600_000, 'op-1', root);
    expect(stolen).toEqual({ v: 2, status: 'conflict', holder: { owner: 'dot-main', claimKey: 'repo:ashlrai/phantom', leaseUntil: NOW + 600_000 } });
    expect(JSON.stringify(stolen)).not.toContain(token);
    // The holder's token still works and the same owner retrying the id re-acquires.
    expect(renew('repo:ashlrai/phantom', token, 600_000, root, NOW))
      .toEqual({ v: 2, status: 'renewed', claim: { claimKey: 'repo:ashlrai/phantom', leaseUntil: NOW + 600_000 } });
    expect(acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root)).toMatchObject({ status: 'acquired' });
    // Once the lease expires the operation id is free for any owner to reuse.
    expect(acquire('repo:ashlrai/phantom', 'other-seat', 600_000, 'op-1', root, NOW + 600_001))
      .toMatchObject({ status: 'acquired', claim: { owner: 'other-seat' } });
  });

  it('refuses wildcard path claims that share a concrete path', () => {
    const root = tempDir('v2claim-');
    // '**/*.ts' and 'src/*.ts' both match src/x.ts; the literal-prefix rule missed this.
    expect(acquire('path:ashlrai/phantom:**/*.ts', 'dot-main', 600_000, 'op-1', root)).toMatchObject({ status: 'acquired' });
    const second = acquire('path:ashlrai/phantom:src/*.ts', 'other-seat', 600_000, 'op-2', root);
    expect(second).toMatchObject({ status: 'conflict', holder: { owner: 'dot-main', claimKey: 'path:ashlrai/phantom:**/*.ts' } });
    // Provably disjoint globs still coordinate independently.
    expect(acquire('path:ashlrai/phantom:docs/*.md', 'third-seat', 600_000, 'op-3', root)).toMatchObject({ status: 'acquired' });
  });

  it('conflicts with a live team claim whose concrete path covers the glob subtree', () => {
    const root = tempDir('v2claim-');
    // A team lease on path 'src' is a prefix claim — it covers 'src' and
    // everything beneath it — so a bus glob matching any of those paths must
    // conflict even though 'src/**' cannot match the bare 'src' string.
    const team = acquireCoordination({ root, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/phantom', path: 'src' }), owner: 'agent:team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-1',
      teamTarget: { repo: 'ashlrai/phantom', path: 'src' }, now: NOW });
    expect(team.status).toBe('acquired');
    expect(acquire('path:ashlrai/phantom:src/**', 'bus-lane', 600_000, 'op-1', root))
      .toMatchObject({ status: 'conflict', holder: { owner: 'agent:team-lane' } });
    expect(acquire('path:ashlrai/phantom:**/*.ts', 'bus-lane', 600_000, 'op-2', root))
      .toMatchObject({ status: 'conflict' });
    // The reverse order conflicts the same way: the bus glob blocks the team claim.
    const root2 = tempDir('v2claim-');
    expect(acquire('path:ashlrai/phantom:src/**', 'bus-lane', 600_000, 'op-1', root2)).toMatchObject({ status: 'acquired' });
    expect(acquireCoordination({ root: root2, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/phantom', path: 'src' }), owner: 'agent:team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-2',
      teamTarget: { repo: 'ashlrai/phantom', path: 'src' }, now: NOW }).status).toBe('conflict');
    // Provably disjoint scopes still coordinate independently.
    const root3 = tempDir('v2claim-');
    expect(acquireCoordination({ root: root3, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/phantom', path: 'src' }), owner: 'agent:team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-3',
      teamTarget: { repo: 'ashlrai/phantom', path: 'src' }, now: NOW }).status).toBe('acquired');
    expect(acquire('path:ashlrai/phantom:docs/**', 'bus-lane', 600_000, 'op-1', root3)).toMatchObject({ status: 'acquired' });
    expect(acquire('path:ashlrai/phantom:src2/**', 'bus-lane', 600_000, 'op-2', root3)).toMatchObject({ status: 'acquired' });
  });

  it('conflicts with a live team claim whose wildcard path covers the glob subtree', () => {
    const root = tempDir('v2claim-');
    // A team lease on 'src/*/foo' is still a prefix claim — `*`/`?` are legal
    // filename characters — so a bus glob matching anything beneath it must
    // conflict even though the two bare globs' languages never intersect.
    const team = acquireCoordination({ root, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/phantom', path: 'src/*/foo' }), owner: 'agent:team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-w1',
      teamTarget: { repo: 'ashlrai/phantom', path: 'src/*/foo' }, now: NOW });
    expect(team.status).toBe('acquired');
    expect(acquire('path:ashlrai/phantom:src/*/foo/bar', 'bus-lane', 600_000, 'op-1', root))
      .toMatchObject({ status: 'conflict', holder: { owner: 'agent:team-lane' } });
    expect(acquire('path:ashlrai/phantom:src/*/foo/**', 'bus-lane', 600_000, 'op-2', root))
      .toMatchObject({ status: 'conflict' });
    // The reverse order conflicts the same way: the bus glob blocks the team claim.
    const root2 = tempDir('v2claim-');
    expect(acquire('path:ashlrai/phantom:src/*/foo/bar', 'bus-lane', 600_000, 'op-1', root2)).toMatchObject({ status: 'acquired' });
    expect(acquireCoordination({ root: root2, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/phantom', path: 'src/*/foo' }), owner: 'agent:team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-w2',
      teamTarget: { repo: 'ashlrai/phantom', path: 'src/*/foo' }, now: NOW }).status).toBe('conflict');
    // Provably disjoint scopes still coordinate independently.
    const root3 = tempDir('v2claim-');
    expect(acquireCoordination({ root: root3, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/phantom', path: 'src/*/foo' }), owner: 'agent:team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-w3',
      teamTarget: { repo: 'ashlrai/phantom', path: 'src/*/foo' }, now: NOW }).status).toBe('acquired');
    expect(acquire('path:ashlrai/phantom:docs/**', 'bus-lane', 600_000, 'op-1', root3)).toMatchObject({ status: 'acquired' });
    expect(acquire('path:ashlrai/phantom:src/*/bar/**', 'bus-lane', 600_000, 'op-2', root3)).toMatchObject({ status: 'acquired' });
  });

  it('lets non-overlapping keys coexist across claim forms', () => {
    const root = tempDir('v2claim-');
    expect(acquire('repo:ashlrai/phantom', 'a', 600_000, 'op-1', root)).toMatchObject({ status: 'acquired' });
    expect(acquire('queue:RQ-OTHER', 'b', 600_000, 'op-2', root)).toMatchObject({ status: 'acquired' });
    expect(acquire('pr:ashlrai/phantom#12', 'c', 600_000, 'op-3', root)).toMatchObject({ status: 'acquired' });
  });

  it('renews, rejects wrong tokens, and frees expired claims', () => {
    const root = tempDir('v2claim-');
    const key = 'queue:RQ-V2-1';
    const token = tokenOf(acquire(key, 'dot-main', 1_000, 'op-1', root));
    expect(renew(key, token, 1_000, root, NOW + 500)).toEqual({ v: 2, status: 'renewed', claim: { claimKey: key, leaseUntil: NOW + 1_500 } });
    expect(renew(key, 'f'.repeat(64), 1_000, root, NOW + 500)).toEqual({ v: 2, status: 'mismatched-token' });
    // A renewal longer than the acquired lease is refused by the store.
    expect(renew(key, token, 2_000, root, NOW + 500)).toEqual({ v: 2, status: 'invalid' });
    expect(release(key, token, 'released', root, NOW + 1_500)).toEqual({ v: 2, status: 'expired' });
    // Expired claims are free: a new owner can acquire the same key.
    const again = acquire(key, 'other-seat', 1_000, 'op-2', root, NOW + 1_500);
    expect(again).toMatchObject({ status: 'acquired', claim: { owner: 'other-seat' } });
    expect(release(key, tokenOf(again), 'completed', root, NOW + 1_600)).toEqual({ v: 2, status: 'completed', claimKey: key });
    expect(release(key, 'e'.repeat(64), 'released', root, NOW + 1_600)).toEqual({ v: 2, status: 'lost' });
  });

  it('rejects malformed claim and release bodies as invalid', () => {
    const root = tempDir('v2claim-');
    for (const body of [
      { kind: 'work.claim', op: 'acquire', claimKey: 'bogus', owner: 'a', leaseMs: 1 },
      { kind: 'work.claim', op: 'acquire', claimKey: 'queue:Q', owner: 'a', leaseMs: 0 },
      { kind: 'work.claim', op: 'acquire', claimKey: 'queue:Q', owner: 'a', leaseMs: 3_600_001 },
      { kind: 'work.claim', op: 'acquire', claimKey: 'queue:Q', leaseMs: 1 },
      { kind: 'work.claim', op: 'acquire', claimKey: 'queue:Q', owner: 'a', leaseMs: 1, extra: 1 },
      { kind: 'work.claim', op: 'bogus', claimKey: 'queue:Q', owner: 'a', leaseMs: 1 },
      { kind: 'work.claim', op: 'renew', claimKey: 'queue:Q', token: 'not-hex', leaseMs: 1 },
      { kind: 'work.release', claimKey: 'queue:Q', token: 'a'.repeat(64), outcome: 'bogus' },
      { kind: 'work.release', claimKey: 'queue:Q', token: 'a'.repeat(64) },
    ]) {
      expect(executeBusClaimBody(body, 'op-bad', { root, now: NOW })).toEqual({ v: 2, status: 'invalid' });
    }
    expect(listCoordination(root, NOW).claims).toHaveLength(0);
  });
});

describe('listBusClaims', () => {
  it('reports a verified-empty store as missing, then lists live claims without tokens', () => {
    const root = tempDir('v2claim-list-');
    expect(listBusClaims({ root, now: NOW })).toEqual({ status: 'ok', source: 'missing', claims: [], asOf: new Date(NOW).toISOString() });
    const token = tokenOf(acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root));
    const listed = listBusClaims({ root, now: NOW });
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') throw new Error('expected ok');
    expect(listed.source).toBe('available');
    expect(listed.claims).toHaveLength(1);
    expect(listed.claims[0]).toMatchObject({ origin: 'resource', key: 'repo:ashlrai/phantom', owner: 'dot-main', live: true });
    expect(JSON.stringify(listed)).not.toContain(token);
    // Expired leases are not holds; the store stays readable.
    expect(listBusClaims({ root, now: NOW + 600_001 })).toMatchObject({ status: 'ok', source: 'available', claims: [] });
  });

  it('narrows to claims that would block an acquire of the given key', () => {
    const root = tempDir('v2claim-list-');
    acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root);
    acquire('queue:RQ-OTHER', 'other-seat', 600_000, 'op-2', root);
    const blocked = listBusClaims({ root, now: NOW, key: 'path:ashlrai/phantom:src/**' });
    expect(blocked).toMatchObject({ status: 'ok' });
    if (blocked.status !== 'ok') throw new Error('expected ok');
    expect(blocked.claims.map(row => row.key)).toEqual(['repo:ashlrai/phantom']);
    expect(listBusClaims({ root, now: NOW, key: 'queue:RQ-FREE' })).toMatchObject({ status: 'ok', claims: [] });
    // Repo claims do not cover PRs; a pr claim blocks only its own number.
    expect(listBusClaims({ root, now: NOW, key: 'pr:ashlrai/phantom#7' })).toMatchObject({ status: 'ok', claims: [] });
    acquire('pr:ashlrai/phantom#7', 'pr-seat', 600_000, 'op-3', root);
    expect(listBusClaims({ root, now: NOW, key: 'pr:ashlrai/phantom#7' })).toMatchObject({ status: 'ok', claims: [{ key: 'pr:ashlrai/phantom#7' }] });
    expect(listBusClaims({ root, now: NOW, key: 'pr:ashlrai/phantom#8' })).toMatchObject({ status: 'ok', claims: [] });
    // A malformed key is invalid, never a silent empty list.
    expect(listBusClaims({ root, now: NOW, key: 'bogus' })).toMatchObject({ status: 'invalid' });
  });

  it('keeps an unreadable table unavailable rather than zero', () => {
    const root = tempDir('v2claim-list-');
    acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root);
    writeFileSync(join(root, 'coordination', 'claims.json'), 'invalid JSON');
    expect(listBusClaims({ root, now: NOW })).toEqual({ status: 'unavailable', asOf: new Date(NOW).toISOString() });
    expect(listBusClaims({ root, now: NOW, key: 'repo:ashlrai/phantom' })).toMatchObject({ status: 'unavailable' });
    expect(listBusClaims({ root, now: NOW, owner: 'dot-main' })).toMatchObject({ status: 'unavailable' });
  });

  it('filters live claims by owner, resolving every label of one identity', () => {
    const root = tempDir('v2claim-list-');
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['lane-atlas'] }, { root }).status).toBe('created');
    const atlasId = stableAgentId('atlas');
    acquire('repo:ashlrai/phantom', 'atlas', 600_000, 'op-1', root);
    acquire('queue:RQ-A', 'agent:atlas', 600_000, 'op-2', root);
    acquire('pr:ashlrai/phantom#3', 'lane-atlas', 600_000, 'op-3', root);
    acquire('queue:RQ-B', 'unregistered', 600_000, 'op-4', root);

    for (const ref of ['atlas', 'agent:atlas', 'lane-atlas', atlasId]) {
      const listed = listBusClaims({ root, now: NOW, owner: ref });
      expect(listed).toMatchObject({ status: 'ok', source: 'available',
        owner: { ref, identity: atlasId, registry: 'available' } });
      if (listed.status !== 'ok') throw new Error('expected ok');
      expect(listed.claims.map(row => row.owner).sort()).toEqual(['agent:atlas', 'atlas', 'lane-atlas']);
    }
    // An unregistered ref falls back to the exact owner label, and says so.
    const labelOnly = listBusClaims({ root, now: NOW, owner: 'unregistered' });
    expect(labelOnly).toMatchObject({ status: 'ok',
      owner: { ref: 'unregistered', identity: null, registry: 'available' } });
    if (labelOnly.status !== 'ok') throw new Error('expected ok');
    expect(labelOnly.claims.map(row => row.owner)).toEqual(['unregistered']);
    // Owner and key filters compose; a missing store stays an honest empty list.
    expect(listBusClaims({ root, now: NOW, owner: 'atlas', key: 'repo:ashlrai/phantom' }))
      .toMatchObject({ status: 'ok', claims: [{ key: 'repo:ashlrai/phantom' }] });
    expect(listBusClaims({ root, now: NOW, owner: 'atlas', key: 'queue:RQ-FREE' }))
      .toMatchObject({ status: 'ok', claims: [] });
    expect(listBusClaims({ root: tempDir('v2claim-list-'), now: NOW, owner: 'atlas' }))
      .toMatchObject({ status: 'ok', source: 'missing', claims: [],
        owner: { ref: 'atlas', identity: null, registry: 'missing' } });
    // A malformed owner is invalid, never a silent empty list.
    expect(listBusClaims({ root, now: NOW, owner: 'bad owner' })).toMatchObject({ status: 'invalid' });
    expect(listBusClaims({ root, now: NOW, owner: '' })).toMatchObject({ status: 'invalid' });
  });

  it('matches only the exact owner label when the registry is unreadable', () => {
    const root = tempDir('v2claim-list-');
    registerAgentIdentity({ handle: 'atlas', aliases: ['lane-atlas'] }, { root });
    acquire('repo:ashlrai/phantom', 'atlas', 600_000, 'op-1', root);
    acquire('queue:RQ-A', 'agent:atlas', 600_000, 'op-2', root);
    writeFileSync(join(root, 'agent-identities', 'registry.json'), 'corrupt');
    const listed = listBusClaims({ root, now: NOW, owner: 'atlas' });
    expect(listed).toMatchObject({ status: 'ok', source: 'available',
      owner: { ref: 'atlas', identity: null, registry: 'unavailable' } });
    if (listed.status !== 'ok') throw new Error('expected ok');
    expect(listed.claims.map(row => row.owner)).toEqual(['atlas']);
  });

  it('joins each claim with the announced feed jobs its keys block when jobs is set', () => {
    const root = tempDir('v2claim-jobs-');
    const post = { kind: 'work.post', jobId: 'RQ-JOB', title: 'T', repo: 'a/b',
      claimKeys: ['queue:RQ-JOB', 'path:a/b:docs/**'], provider: 'devin' };
    expect(appendBusInbox({ id: 'w-post-1', from: 'agent-1', to: 'leaders', priority: 'P2',
      ttl: 86_400_000, body: post }, { root, now: () => NOW }).status).toBe('posted');
    acquire('queue:RQ-JOB', 'worker-1', 600_000, 'op-1', root);
    acquire('repo:other/repo', 'worker-2', 600_000, 'op-2', root);

    const listed = listBusClaims({ root, now: NOW, jobs: true });
    expect(listed).toMatchObject({ status: 'ok', source: 'available', feed: 'ok' });
    if (listed.status !== 'ok') throw new Error('expected ok');
    const byKey = new Map(listed.claims.map(row => [row.key, row]));
    // The queue claim overlaps the job's queue key; the unrelated repo claim blocks nothing.
    // The blocked job carries the retained post/status receipt citations.
    expect(byKey.get('queue:RQ-JOB')?.jobs).toEqual([{ id: 'RQ-JOB', owner: 'agent-1', status: 'queued', title: 'T',
      postId: 'w-post-1', statusId: null }]);
    expect(byKey.get('repo:other/repo')?.jobs).toEqual([]);
    // Without jobs the same claims carry no feed join and no feed state.
    const plain = listBusClaims({ root, now: NOW });
    if (plain.status !== 'ok') throw new Error('expected ok');
    expect(plain.feed).toBeUndefined();
    expect(plain.claims.every(row => row.jobs === undefined)).toBe(true);
  });

  it('leaves jobs absent and reports the feed state when the feed cannot be read', () => {
    const root = tempDir('v2claim-jobs-');
    // A work.post with no provider and no registry hint refuses the whole feed.
    const post = { kind: 'work.post', jobId: 'RQ-BAD', title: 'T', repo: 'a/b', claimKeys: ['queue:RQ-BAD'] };
    expect(appendBusInbox({ id: 'w-post-2', from: 'agent-1', to: 'leaders', priority: 'P2',
      ttl: 86_400_000, body: post }, { root, now: () => NOW }).status).toBe('posted');
    acquire('queue:RQ-JOB', 'worker-1', 600_000, 'op-1', root);

    const listed = listBusClaims({ root, now: NOW, jobs: true });
    expect(listed).toMatchObject({ status: 'ok', source: 'available', feed: 'refused' });
    if (listed.status !== 'ok') throw new Error('expected ok');
    // Claims still list; blocked work stays unknown rather than an empty list.
    expect(listed.claims).toHaveLength(1);
    expect(listed.claims[0]?.jobs).toBeUndefined();
  });

  it('filters live claims by origin class and composes with owner and key', () => {
    const root = tempDir('v2claim-list-');
    acquire('queue:RQ-RESOURCE-1', 'dot-main', 600_000, 'op-1', root);
    expect(acquireCoordination({ root, origin: 'message', key: 'queue:env-msg-1',
      owner: 'nova', leaseMs: 600_000, leaseUntil: NOW + 600_000,
      sourceId: 'env-msg-1:1:1', now: NOW }).status).toBe('acquired');
    expect(acquireCoordination({ root, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/phantom', path: 'src' }), owner: 'team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-1',
      teamTarget: { repo: 'ashlrai/phantom', path: 'src' }, now: NOW }).status).toBe('acquired');
    expect(acquireCoordination({ root, origin: 'board', key: 'board:item-1',
      owner: 'board-op', leaseMs: 600_000, leaseUntil: NOW + 600_000,
      sourceId: 'item-1', now: NOW }).status).toBe('acquired');

    const all = listBusClaims({ root, now: NOW });
    expect(all).toMatchObject({ status: 'ok', source: 'available' });
    if (all.status !== 'ok') throw new Error('expected ok');
    expect(all.claims.map(row => row.origin).sort()).toEqual(['board', 'message', 'resource', 'team']);

    for (const [origin, key] of [['resource', 'queue:RQ-RESOURCE-1'], ['message', 'queue:env-msg-1'],
      ['team', 'team:ashlrai/phantom::src'], ['board', 'board:item-1']] as const) {
      expect(listBusClaims({ root, now: NOW, origin }))
        .toMatchObject({ status: 'ok', claims: [{ origin, key }] });
    }
    // Origin composes with the owner and key filters.
    expect(listBusClaims({ root, now: NOW, origin: 'message', owner: 'nova' }))
      .toMatchObject({ status: 'ok', claims: [{ origin: 'message', owner: 'nova' }] });
    expect(listBusClaims({ root, now: NOW, origin: 'resource', owner: 'nova' }))
      .toMatchObject({ status: 'ok', claims: [] });
    // --key keeps its own v2 claim-key grammar, so it composes with --origin
    // only through keys the overlap rule understands.
    expect(listBusClaims({ root, now: NOW, origin: 'resource', key: 'queue:RQ-RESOURCE-1' }))
      .toMatchObject({ status: 'ok', claims: [{ origin: 'resource', key: 'queue:RQ-RESOURCE-1' }] });
    expect(listBusClaims({ root, now: NOW, origin: 'message', key: 'queue:RQ-RESOURCE-1' }))
      .toMatchObject({ status: 'ok', claims: [] });
    // An origin outside the stored claim classes — including 'queue', which
    // exists only on read-only path observations — is invalid, never a
    // silent empty list.
    expect(listBusClaims({ root, now: NOW, origin: 'bogus' as never })).toMatchObject({ status: 'invalid' });
    expect(listBusClaims({ root, now: NOW, origin: 'queue' as never })).toMatchObject({ status: 'invalid' });
  });

  it('drops one holder under excludeOwner, resolving every label of one identity', () => {
    const root = tempDir('v2claim-list-');
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['lane-atlas'] }, { root }).status).toBe('created');
    const atlasId = stableAgentId('atlas');
    acquire('repo:ashlrai/phantom', 'atlas', 600_000, 'op-1', root);
    acquire('queue:RQ-A', 'agent:atlas', 600_000, 'op-2', root);
    acquire('pr:ashlrai/phantom#3', 'lane-atlas', 600_000, 'op-3', root);
    acquire('queue:RQ-B', 'unregistered', 600_000, 'op-4', root);

    for (const ref of ['atlas', 'agent:atlas', 'lane-atlas', atlasId]) {
      const listed = listBusClaims({ root, now: NOW, excludeOwner: ref });
      expect(listed).toMatchObject({ status: 'ok', source: 'available',
        excludeOwner: { ref, identity: atlasId, registry: 'available' } });
      if (listed.status !== 'ok') throw new Error('expected ok');
      expect(listed.claims.map(row => row.owner)).toEqual(['unregistered']);
    }
    // An unregistered ref falls back to the exact owner label, and says so.
    const labelOnly = listBusClaims({ root, now: NOW, excludeOwner: 'unregistered' });
    expect(labelOnly).toMatchObject({ status: 'ok',
      excludeOwner: { ref: 'unregistered', identity: null, registry: 'available' } });
    if (labelOnly.status !== 'ok') throw new Error('expected ok');
    expect(labelOnly.claims.map(row => row.owner).sort()).toEqual(['agent:atlas', 'atlas', 'lane-atlas']);
    // owner and excludeOwner compose: include atlas's claims minus atlas's claims lists nothing.
    expect(listBusClaims({ root, now: NOW, owner: 'atlas', excludeOwner: 'atlas' }))
      .toMatchObject({ status: 'ok', claims: [] });
    expect(listBusClaims({ root, now: NOW, excludeOwner: 'atlas' }))
      .toMatchObject({ status: 'ok', claims: [{ owner: 'unregistered' }] });
    // A malformed exclude-owner is invalid, never a silent empty list.
    expect(listBusClaims({ root, now: NOW, excludeOwner: 'bad owner' })).toMatchObject({ status: 'invalid' });
    expect(listBusClaims({ root, now: NOW, excludeOwner: '' })).toMatchObject({ status: 'invalid' });
  });

  it('matches only the exact owner label under excludeOwner when the registry is unreadable', () => {
    const root = tempDir('v2claim-list-');
    registerAgentIdentity({ handle: 'atlas', aliases: ['lane-atlas'] }, { root });
    acquire('repo:ashlrai/phantom', 'atlas', 600_000, 'op-1', root);
    acquire('queue:RQ-A', 'agent:atlas', 600_000, 'op-2', root);
    writeFileSync(join(root, 'agent-identities', 'registry.json'), 'corrupt');
    const listed = listBusClaims({ root, now: NOW, excludeOwner: 'atlas' });
    expect(listed).toMatchObject({ status: 'ok', source: 'available',
      excludeOwner: { ref: 'atlas', identity: null, registry: 'unavailable' } });
    if (listed.status !== 'ok') throw new Error('expected ok');
    expect(listed.claims.map(row => row.owner)).toEqual(['agent:atlas']);
  });

  it('keeps claims whose rendered fields carry the contains needle', () => {
    const root = tempDir('v2claim-list-');
    acquire('repo:ashlrai/phantom', 'dot-main', 600_000, 'op-1', root);
    acquire('queue:RQ-OTHER', 'other-seat', 600_000, 'op-2', root);
    expect(acquireCoordination({ root, origin: 'message', key: 'queue:env-msg-1',
      owner: 'nova', leaseMs: 600_000, leaseUntil: NOW + 600_000,
      sourceId: 'env-msg-1:1:1', now: NOW }).status).toBe('acquired');
    expect(acquireCoordination({ root, origin: 'team',
      key: teamClaimKey({ repo: 'ashlrai/other', path: 'src' }), owner: 'team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-1',
      teamTarget: { repo: 'ashlrai/other', path: 'src' }, now: NOW }).status).toBe('acquired');

    // The needle is a case-insensitive substring over the claim's own fields:
    // 'phantom' names only the repo claim's key, 'env-msg-1:1' and 'team-ev'
    // name only the two sourceIds (never their keys), and 'other' names the
    // queue claim's key plus the team claim's key and repo target.
    const phantom = listBusClaims({ root, now: NOW, contains: 'PHANTOM' });
    expect(phantom).toMatchObject({ status: 'ok', source: 'available' });
    if (phantom.status !== 'ok') throw new Error('expected ok');
    expect(phantom.claims.map(row => row.key)).toEqual(['repo:ashlrai/phantom']);

    expect(listBusClaims({ root, now: NOW, contains: 'env-msg-1:1' }))
      .toMatchObject({ status: 'ok', claims: [{ key: 'queue:env-msg-1' }] });
    expect(listBusClaims({ root, now: NOW, contains: 'team-ev' }))
      .toMatchObject({ status: 'ok', claims: [{ origin: 'team' }] });
    const others = listBusClaims({ root, now: NOW, contains: 'other' });
    if (others.status !== 'ok') throw new Error('expected ok');
    expect(others.claims.map(row => row.key).sort()).toEqual(['queue:RQ-OTHER', 'team:ashlrai/other::src']);

    // contains composes with the other filters.
    expect(listBusClaims({ root, now: NOW, contains: 'other', owner: 'team-lane' }))
      .toMatchObject({ status: 'ok', claims: [{ origin: 'team' }] });
    expect(listBusClaims({ root, now: NOW, contains: 'other', origin: 'message' }))
      .toMatchObject({ status: 'ok', claims: [] });
    expect(listBusClaims({ root, now: NOW, contains: 'other', excludeOwner: 'other-seat' }))
      .toMatchObject({ status: 'ok', claims: [{ origin: 'team' }] });

    // A blank or oversized needle is invalid, never a silent empty list.
    expect(listBusClaims({ root, now: NOW, contains: '   ' })).toMatchObject({ status: 'invalid' });
    expect(listBusClaims({ root, now: NOW, contains: 'x'.repeat(513) })).toMatchObject({ status: 'invalid' });
  });

  it('keeps claims whose recorded started lands inside the since/before window', () => {
    const root = tempDir('v2claim-list-');
    // Two live resource claims taken at different instants: started is the
    // lease's ISO acquisition time and both stay live at NOW.
    acquire('repo:a/old', 'seat-a', 600_000, 'op-old', root, NOW - 120_000);
    acquire('repo:a/new', 'seat-b', 600_000, 'op-new', root, NOW);
    // Team and message claims keep no start stamp — started stays null.
    expect(acquireCoordination({ root, origin: 'team',
      key: teamClaimKey({ repo: 'a/b', path: 'src' }), owner: 'team-lane',
      leaseMs: 600_000, leaseUntil: NOW + 600_000, sourceId: 'team-ev-1',
      teamTarget: { repo: 'a/b', path: 'src' }, now: NOW }).status).toBe('acquired');
    expect(acquireCoordination({ root, origin: 'message', key: 'queue:env-msg-1',
      owner: 'nova', leaseMs: 600_000, leaseUntil: NOW + 600_000,
      sourceId: 'env-msg-1:1:1', now: NOW }).status).toBe('acquired');

    const all = listBusClaims({ root, now: NOW });
    expect(all).toMatchObject({ status: 'ok', source: 'available' });
    if (all.status !== 'ok') throw new Error('expected ok');
    expect(all.claims).toHaveLength(4);
    expect(all.claims.find(row => row.origin === 'team')?.started).toBeNull();
    expect(all.claims.find(row => row.origin === 'message')?.started).toBeNull();

    const keys = (result: ReturnType<typeof listBusClaims>) => {
      if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
      return result.claims.map(row => row.key).sort();
    };
    // since is the inclusive lower bound on started: only the claim taken at
    // NOW reaches a cutoff 60s back; the older one and the stamp-less rows drop.
    expect(keys(listBusClaims({ root, now: NOW, since: NOW - 60_000 }))).toEqual(['repo:a/new']);
    // before is the exclusive upper bound on the same field.
    expect(keys(listBusClaims({ root, now: NOW, before: NOW - 60_000 }))).toEqual(['repo:a/old']);
    // The pair reads one [since, before) window.
    expect(keys(listBusClaims({ root, now: NOW, since: NOW - 180_000, before: NOW - 60_000 })))
      .toEqual(['repo:a/old']);
    expect(keys(listBusClaims({ root, now: NOW, since: NOW - 60_000, before: NOW + 60_000 })))
      .toEqual(['repo:a/new']);
    // Boundaries match the shared rule: a start stamped exactly at since
    // lists, one stamped exactly at before does not.
    expect(keys(listBusClaims({ root, now: NOW, since: NOW }))).toEqual(['repo:a/new']);
    expect(keys(listBusClaims({ root, now: NOW, before: NOW }))).toEqual(['repo:a/old']);
    // A window nothing provably started inside stays an honest empty list.
    expect(listBusClaims({ root, now: NOW, since: NOW + 1 }))
      .toMatchObject({ status: 'ok', source: 'available', claims: [] });
    // The window composes with the other filters.
    expect(listBusClaims({ root, now: NOW, since: NOW - 60_000, owner: 'seat-b' }))
      .toMatchObject({ status: 'ok', claims: [{ key: 'repo:a/new' }] });
    expect(listBusClaims({ root, now: NOW, before: NOW - 60_000, origin: 'resource' }))
      .toMatchObject({ status: 'ok', claims: [{ key: 'repo:a/old' }] });
    expect(listBusClaims({ root, now: NOW, since: NOW - 60_000, origin: 'team' }))
      .toMatchObject({ status: 'ok', claims: [] });
    // Non-integer or negative cutoffs are invalid, never a silent widen.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(listBusClaims({ root, now: NOW, since: bad })).toMatchObject({ status: 'invalid' });
      expect(listBusClaims({ root, now: NOW, before: bad })).toMatchObject({ status: 'invalid' });
    }
  });
});

describe('claimBusWorkJob', () => {
  const postWork = (root: string, jobId: string, claimKeys: string[], repo = 'a/b') => {
    const body = { kind: 'work.post', jobId, title: `Job ${jobId}`, repo, claimKeys, provider: 'devin' };
    const posted = appendBusInbox({ id: `w-post-${jobId}`, from: 'agent-1', to: 'leaders', priority: 'P2',
      ttl: 86_400_000, body }, { root, now: () => NOW });
    expect(posted.status).toBe('posted');
  };
  const postStatus = (root: string, jobId: string, status: string) => {
    const body = { kind: 'work.status', jobId, status };
    const posted = appendBusInbox({ id: `w-status-${jobId}-${status}`, from: 'agent-1', to: 'leaders', priority: 'P2',
      ttl: 86_400_000, body }, { root, now: () => NOW });
    expect(posted.status).toBe('posted');
  };

  it('claims the declared queue key by default and lands it in the coordination table', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-J1', ['queue:RQ-J1', 'repo:a/b']);
    const result = claimBusWorkJob({ root, now: NOW, job: 'RQ-J1', owner: 'worker-1', leaseMs: 600_000, id: 'op-j1' });
    expect(result).toMatchObject({ status: 'acquired',
      job: { id: 'RQ-J1', owner: 'agent-1', repo: 'a/b', title: 'Job RQ-J1', status: 'queued' },
      scope: { source: 'missing', holds: [] },
      claim: { claimKey: 'queue:RQ-J1', owner: 'worker-1', leaseMs: 600_000, leaseUntil: NOW + 600_000 } });
    if (result.status !== 'acquired') throw new Error('expected acquired');
    expect(result.claim.token).toMatch(TOKEN_RE);
    const listed = listCoordination(root, NOW);
    expect(listed.claims).toEqual([expect.objectContaining({ origin: 'resource', key: 'queue:RQ-J1',
      owner: 'worker-1', live: true })]);
  });

  it('falls back to the first declared key and honors an explicit declared key', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-NQ', ['repo:a/b', 'path:a/b:src/**']);
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-NQ', owner: 'w1', leaseMs: 1_000, id: 'op-nq' }))
      .toMatchObject({ status: 'acquired', claim: { claimKey: 'repo:a/b' } });
    postWork(root, 'RQ-QK', ['queue:RQ-QK', 'repo:c/d'], 'c/d');
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-QK', owner: 'w2', leaseMs: 1_000, key: 'repo:c/d', id: 'op-qk' }))
      .toMatchObject({ status: 'acquired', claim: { claimKey: 'repo:c/d' } });
    // The default still prefers the declared queue key over the first entry.
    postWork(root, 'RQ-DEF', ['repo:e/f', 'queue:RQ-DEF'], 'e/f');
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-DEF', owner: 'w3', leaseMs: 1_000, id: 'op-def' }))
      .toMatchObject({ status: 'acquired', claim: { claimKey: 'queue:RQ-DEF' } });
  });

  it('refuses undeclared keys, unknown jobs, non-open jobs and keyless jobs before any lease', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-K', ['queue:RQ-K']);
    postWork(root, 'RQ-DONE', ['queue:RQ-DONE']);
    postStatus(root, 'RQ-DONE', 'done');
    postWork(root, 'RQ-RUN', ['queue:RQ-RUN']);
    postStatus(root, 'RQ-RUN', 'running');
    postWork(root, 'RQ-EMPTY', []);
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-K', owner: 'w', leaseMs: 1_000, key: 'queue:OTHER' }))
      .toMatchObject({ status: 'refused', reason: 'undeclared-key', job: { id: 'RQ-K' } });
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-GONE', owner: 'w', leaseMs: 1_000 }))
      .toMatchObject({ status: 'invalid', reason: 'unknown-job' });
    for (const [job, status] of [['RQ-DONE', 'done'], ['RQ-RUN', 'running']] as const) {
      expect(claimBusWorkJob({ root, now: NOW, job, owner: 'w', leaseMs: 1_000 }))
        .toMatchObject({ status: 'refused', reason: 'job-not-open', job: { id: job, status } });
    }
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-EMPTY', owner: 'w', leaseMs: 1_000 }))
      .toMatchObject({ status: 'refused', reason: 'no-claim-keys', job: { id: 'RQ-EMPTY' } });
    expect(listCoordination(root, NOW).claims).toHaveLength(0);
  });

  it('reports a live conflict with the holder and never the token', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-C', ['queue:RQ-C']);
    const first = claimBusWorkJob({ root, now: NOW, job: 'RQ-C', owner: 'worker-1', leaseMs: 600_000, id: 'op-c1' });
    if (first.status !== 'acquired') throw new Error('expected acquired');
    const second = claimBusWorkJob({ root, now: NOW, job: 'RQ-C', owner: 'worker-2', leaseMs: 600_000, id: 'op-c2' });
    expect(second).toEqual({ status: 'conflict',
      job: { id: 'RQ-C', owner: 'agent-1', repo: 'a/b', title: 'Job RQ-C', status: 'queued',
        postId: 'w-post-RQ-C', statusId: null },
      scope: { source: 'available', holds: [] },
      holder: { owner: 'worker-1', claimKey: 'queue:RQ-C', leaseUntil: NOW + 600_000 } });
    expect(JSON.stringify(second)).not.toContain(first.claim.token);
  });

  it('conflicts when a second owner reuses a live claim operation id', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-O', ['queue:RQ-O']);
    const first = claimBusWorkJob({ root, now: NOW, job: 'RQ-O', owner: 'worker-1', leaseMs: 600_000, id: 'op-shared' });
    if (first.status !== 'acquired') throw new Error('expected acquired');
    // worker-2 presenting the same --id is not worker-1's retry: the live lease
    // conflicts with its holder instead of being silently replaced.
    const second = claimBusWorkJob({ root, now: NOW, job: 'RQ-O', owner: 'worker-2', leaseMs: 600_000, id: 'op-shared' });
    expect(second).toMatchObject({ status: 'conflict',
      holder: { owner: 'worker-1', claimKey: 'queue:RQ-O', leaseUntil: NOW + 600_000 } });
    expect(JSON.stringify(second)).not.toContain(first.claim.token);
    // worker-1's fencing token still renews the untouched lease.
    expect(executeBusClaimBody({ kind: 'work.claim', op: 'renew', claimKey: 'queue:RQ-O',
      token: first.claim.token, leaseMs: 600_000 }, 'op-renew', { root, now: NOW }))
      .toMatchObject({ v: 2, status: 'renewed' });
  });

  it('reports live holds on the job\'s other declared keys in the claim scope', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-S', ['queue:RQ-S', 'repo:a/b', 'pr:c/d#7'], 'a/b');
    // Another participant already holds the repo scope; the queue key is free.
    acquire('repo:a/b', 'other-owner', 600_000, 'op-hold', root);
    const result = claimBusWorkJob({ root, now: NOW, job: 'RQ-S', owner: 'worker-1', leaseMs: 600_000, id: 'op-s' });
    expect(result).toMatchObject({ status: 'acquired', claim: { claimKey: 'queue:RQ-S' },
      scope: { source: 'available',
        holds: [{ claimKey: 'repo:a/b', owner: 'other-owner', leaseUntil: NOW + 600_000 }] } });
    // The targeted queue key never appears among its own sibling holds.
    if (result.status !== 'acquired') throw new Error('expected acquired');
    expect(result.scope.holds.some(hold => hold.claimKey === 'queue:RQ-S')).toBe(false);
  });

  it('carries sibling scope holds on a conflict and drops expired holds', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-Y', ['queue:RQ-Y', 'repo:a/b', 'repo:e/f']);
    acquire('queue:RQ-Y', 'worker-1', 600_000, 'op-yq', root);
    acquire('repo:a/b', 'worker-1', 600_000, 'op-yr', root);
    // repo:e/f is held but already expired at the claim instant: not a live hold.
    acquire('repo:e/f', 'worker-9', 1_000, 'op-ye', root);
    const conflict = claimBusWorkJob({ root, now: NOW + 2_000, job: 'RQ-Y', owner: 'worker-2', leaseMs: 600_000, id: 'op-y2' });
    expect(conflict).toMatchObject({ status: 'conflict',
      holder: { owner: 'worker-1', claimKey: 'queue:RQ-Y' },
      scope: { source: 'available',
        holds: [{ claimKey: 'repo:a/b', owner: 'worker-1', leaseUntil: NOW + 600_000 }] } });
  });

  it('reports the full hold map on refused outcomes', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-H', ['queue:RQ-H', 'repo:a/b'], 'a/b');
    postStatus(root, 'RQ-H', 'running');
    postWork(root, 'RQ-U', ['queue:RQ-U', 'repo:c/d'], 'c/d');
    postWork(root, 'RQ-E2', []);
    // Live holds across the running job's declared keys — the queue key a
    // worker would claim and a sibling repo scope — must surface on the
    // refusal itself, queue key included.
    acquire('queue:RQ-H', 'runner-9', 600_000, 'op-hq', root);
    acquire('repo:a/b', 'holder-1', 600_000, 'op-hr', root);
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-H', owner: 'w', leaseMs: 1_000 }))
      .toMatchObject({ status: 'refused', reason: 'job-not-open',
        scope: { source: 'available', holds: [
          { claimKey: 'queue:RQ-H', owner: 'runner-9', leaseUntil: NOW + 600_000 },
          { claimKey: 'repo:a/b', owner: 'holder-1', leaseUntil: NOW + 600_000 }] } });
    // An undeclared --key refuses with the same full map over declared keys.
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-U', owner: 'w', leaseMs: 1_000, key: 'queue:OTHER' }))
      .toMatchObject({ status: 'refused', reason: 'undeclared-key',
        scope: { source: 'available', holds: [] } });
    // A keyless job reports an honest empty hold map, never a missing scope.
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-E2', owner: 'w', leaseMs: 1_000 }))
      .toMatchObject({ status: 'refused', reason: 'no-claim-keys',
        scope: { source: 'available', holds: [] } });
  });

  it('keeps scope honest when the coordination table is unreadable', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-B', ['queue:RQ-B']);
    postStatus(root, 'RQ-B', 'blocked');
    postWork(root, 'RQ-O2', ['queue:RQ-O2']);
    // A live claim creates the store file, then corruption makes every
    // coordination read unavailable — holds stay unknown, never a free set.
    acquire('repo:z/z', 'holder-9', 600_000, 'op-z', root);
    writeFileSync(join(root, 'coordination', 'claims.json'), 'corrupt');
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-B', owner: 'w', leaseMs: 1_000 }))
      .toMatchObject({ status: 'refused', reason: 'job-not-open',
        scope: { source: 'unavailable', holds: [] } });
    // The post-attempt failure path carries the same honest scope.
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-O2', owner: 'w', leaseMs: 1_000 }))
      .toMatchObject({ status: 'unavailable', reason: 'claim-unavailable',
        scope: { source: 'unavailable', holds: [] } });
  });

  it('refuses malformed input before touching the feed', () => {
    const root = tempDir('v2jobclaim-');
    postWork(root, 'RQ-I', ['queue:RQ-I']);
    for (const bad of [
      { job: 'bad job', owner: 'w', leaseMs: 1 },
      { job: 'RQ-I', owner: 'bad owner', leaseMs: 1 },
      { job: 'RQ-I', owner: 'w', leaseMs: 0 },
      { job: 'RQ-I', owner: 'w', leaseMs: 3_600_001 },
      { job: 'RQ-I', owner: 'w', leaseMs: 1.5 },
      { job: 'RQ-I', owner: 'w', leaseMs: 1, key: 'bogus' },
    ]) {
      expect(claimBusWorkJob({ root, now: NOW, ...bad })).toMatchObject({ status: 'invalid' });
    }
    expect(listCoordination(root, NOW).claims).toHaveLength(0);
  });

  it('maps a refused or unreadable feed honestly instead of claiming blind', () => {
    const root = tempDir('v2jobclaim-');
    // A work.post with no provider and no registry hint refuses the whole feed.
    const post = { kind: 'work.post', jobId: 'RQ-NP', title: 'T', repo: 'a/b', claimKeys: ['queue:RQ-NP'] };
    expect(appendBusInbox({ id: 'w-noprovider', from: 'agent-1', to: 'leaders', priority: 'P2',
      ttl: 86_400_000, body: post }, { root, now: () => NOW }).status).toBe('posted');
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-NP', owner: 'w', leaseMs: 1_000 }))
      .toEqual({ status: 'refused', reason: 'work-feed-missing-provider' });
    // A damaged inbox snapshot makes the feed unavailable, never a guessed claim.
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), 'corrupt');
    expect(claimBusWorkJob({ root, now: NOW, job: 'RQ-NP', owner: 'w', leaseMs: 1_000 }))
      .toEqual({ status: 'unavailable', reason: 'work-feed-unavailable' });
    expect(listCoordination(root, NOW).claims).toHaveLength(0);
  });
});

// ─── HTTP surface ────────────────────────────────────────────────────

const HTTP_PATH = '/api/verse/agent-bus';
const HTTP_TOKEN = 'fake-http-token';

describe('POST /api/verse/agent-bus claim operations', () => {
  let home: string;
  let now: number;
  beforeEach(() => {
    home = tempDir('v2claim-http-');
    vi.stubEnv('ASHLR_HOME', join(home, 'ashlr'));
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  async function http(method: 'GET' | 'POST', body?: unknown, authorized = true, allowDispatch = true) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
    req.url = HTTP_PATH;
    req.method = method;
    req.headers = { 'content-type': 'application/json', ...(authorized ? { 'x-ashlr-token': HTTP_TOKEN } : {}) };
    let status = 0;
    let wire: unknown;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; this.headersSent = true; },
      end(payload: string) { wire = JSON.parse(payload); },
    } as unknown as ServerResponse;
    const ctx = { cfg: {}, token: HTTP_TOKEN, allowDispatch, readSession: { id: 'fake-session', expiresAt: now + 60_000 } } as VerseApiContext;
    expect(await handleAgentBusApi(ctx, req, res, HTTP_PATH, method)).toBe(true);
    return { status, wire };
  }

  const envelope = (id: string, body: unknown) => ({ id, from: 'dot-main', to: 'leaders', priority: 'P2', ttl: 3_600_000, body });

  it('executes acquire/renew/release and returns the unsanitized fencing token', async () => {
    const acquireBody = { kind: 'work.claim', op: 'acquire', claimKey: 'path:ashlrai/phantom:docs/**', owner: 'dot-main', leaseMs: 600_000 };
    const first = await http('POST', envelope('claim-0001', acquireBody));
    expect(first.status).toBe(201);
    expect(first.wire).toMatchObject({ v: 2, status: 'acquired', claim: { claimKey: 'path:ashlrai/phantom:docs/**', owner: 'dot-main', leaseUntil: now + 600_000 } });
    const token = (first.wire as { claim: { token: string } }).claim.token;
    expect(token).toMatch(TOKEN_RE);

    const conflict = await http('POST', envelope('claim-0002', { ...acquireBody, owner: 'other-seat' }));
    expect(conflict.status).toBe(409);
    expect(conflict.wire).toEqual({ v: 2, status: 'conflict', holder: { owner: 'dot-main', claimKey: 'path:ashlrai/phantom:docs/**', leaseUntil: now + 600_000 } });
    expect(JSON.stringify(conflict.wire)).not.toContain(token);

    const renewed = await http('POST', envelope('claim-0003', { kind: 'work.claim', op: 'renew', claimKey: 'path:ashlrai/phantom:docs/**', token, leaseMs: 600_000 }));
    expect(renewed).toMatchObject({ status: 200, wire: { v: 2, status: 'renewed' } });

    const released = await http('POST', envelope('claim-0004', { kind: 'work.release', claimKey: 'path:ashlrai/phantom:docs/**', token, outcome: 'released' }));
    expect(released).toMatchObject({ status: 200, wire: { v: 2, status: 'released', claimKey: 'path:ashlrai/phantom:docs/**' } });
  });

  it('maps invalid claim bodies to 400 and keeps ordinary mail on the append path', async () => {
    const bad = await http('POST', envelope('claim-bad', { kind: 'work.claim', op: 'acquire', claimKey: 'bogus', owner: 'a', leaseMs: 1 }));
    expect(bad).toMatchObject({ status: 400, wire: { v: 2, status: 'invalid' } });

    const note = envelope('note-0001', { kind: 'note', text: 'hello' });
    expect(await http('POST', note)).toMatchObject({ status: 201, wire: { v: 1, status: 'posted', cursor: 1 } });
    // Claim operations never append: the inbox still holds only the note.
    const page = (await http('GET', undefined)).wire as { status: string; nextCursor: number; messages: unknown[] };
    expect(page).toMatchObject({ status: 'ok', nextCursor: 1 });
    expect(page.messages).toHaveLength(1);

    // The mutation gate still applies to claim operations.
    expect(await http('POST', envelope('claim-denied', { kind: 'work.claim', op: 'acquire', claimKey: 'queue:Q', owner: 'a', leaseMs: 1 }), false))
      .toMatchObject({ status: 401 });
    expect(await http('POST', envelope('claim-nodisp', { kind: 'work.claim', op: 'acquire', claimKey: 'queue:Q', owner: 'a', leaseMs: 1 }), true, false))
      .toMatchObject({ status: 404 });
  });
});

// ─── CLI surface ─────────────────────────────────────────────────────

describe('phm agents bus claim', () => {
  let cliBase: string;
  let cliRoot: string;
  let previousRuns: string | undefined;
  beforeEach(() => {
    cliBase = tempDir('v2claim-cli-');
    cliRoot = join(cliBase, 'fleet');
    previousRuns = process.env['ASHLR_RUNS_DIR'];
    process.env['ASHLR_RUNS_DIR'] = join(cliBase, 'runs');
  });
  afterEach(() => {
    if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
    else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  });

  async function cli(args: string[], env: NodeJS.ProcessEnv = {}, json = true) {
    const out: string[] = [], err: string[] = [];
    const code = await runAgentsBusUnified([...args, ...(json ? ['--json'] : []), '--root', cliRoot], t => out.push(t), t => err.push(t), env);
    const text = out.length ? out.join('\n') : err.join('\n');
    return { code, json: json && out.length ? JSON.parse(text) : undefined, text };
  }

  it('acquires, conflicts, renews and releases through the shared table', async () => {
    const first = await cli(['claim', 'acquire', '--key', 'repo:ashlrai/phantom', '--lease-ms', '600000', '--owner', 'dot-main', '--id', 'cli-op-1'], { PHM_AGENT_ID: 'dot-main' });
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({ v: 2, status: 'acquired', claim: { claimKey: 'repo:ashlrai/phantom', owner: 'dot-main' } });
    expect(first.json.claim.token).toMatch(TOKEN_RE);

    const conflict = await cli(['claim', 'acquire', '--key', 'path:ashlrai/phantom:src/**', '--lease-ms', '600000', '--owner', 'other'], { PHM_AGENT_ID: 'other' });
    expect(conflict.code).toBe(1);
    expect(conflict.json).toMatchObject({ v: 2, status: 'conflict', holder: { owner: 'dot-main', claimKey: 'repo:ashlrai/phantom' } });

    const renewed = await cli(['claim', 'renew', '--key', 'repo:ashlrai/phantom', '--token', first.json.claim.token, '--lease-ms', '600000']);
    expect(renewed.code).toBe(0);
    expect(renewed.json).toMatchObject({ v: 2, status: 'renewed' });

    const wrongToken = await cli(['claim', 'release', '--key', 'repo:ashlrai/phantom', '--token', 'f'.repeat(64), '--outcome', 'released']);
    expect(wrongToken.code).toBe(1);
    expect(wrongToken.json).toMatchObject({ v: 2, status: 'mismatched-token' });

    const released = await cli(['claim', 'release', '--key', 'repo:ashlrai/phantom', '--token', first.json.claim.token, '--outcome', 'completed']);
    expect(released.code).toBe(0);
    expect(released.json).toMatchObject({ v: 2, status: 'completed', claimKey: 'repo:ashlrai/phantom' });

    const lost = await cli(['claim', 'release', '--key', 'repo:ashlrai/phantom', '--token', first.json.claim.token, '--outcome', 'released']);
    expect(lost.code).toBe(1);
    expect(lost.json).toMatchObject({ v: 2, status: 'lost' });
  });

  it('defaults the claim owner to PHM_AGENT_ID and prints a human line without --json', async () => {
    const result = await cli(['claim', 'acquire', '--key', 'queue:RQ-CLI', '--lease-ms', '60000'], { PHM_AGENT_ID: 'nova' }, false);
    expect(result.code).toBe(0);
    expect(result.text).toContain('acquired queue:RQ-CLI owner=nova');
    expect(result.text).toContain('token=');
  });

  it('returns 2 for usage errors and invalid claim arguments', async () => {
    expect(await cli(['claim', 'acquire', '--lease-ms', '60000'])).toMatchObject({ code: 2 });
    expect(await cli(['claim', 'bogus', '--key', 'queue:Q'])).toMatchObject({ code: 2 });
    expect(await cli(['claim', 'acquire', '--key', 'queue:Q'])).toMatchObject({ code: 2 });
    expect(await cli(['claim', 'renew', '--key', 'queue:Q', '--token', 'a'.repeat(64)])).toMatchObject({ code: 2 });
    expect(await cli(['claim', 'acquire', '--key', 'bogus', '--lease-ms', '60000', '--owner', 'a'], {})).toMatchObject({ code: 2 });
    expect(await cli(['claim', 'acquire', '--key', 'queue:Q', '--lease-ms', '60000'])).toMatchObject({ code: 2 });
  });

  it('filters claim list by --origin and rejects a bad origin', async () => {
    const now = Date.now();
    const lease = { leaseMs: 600_000, leaseUntil: now + 600_000, now };
    expect(acquireCoordination({ root: cliRoot, origin: 'resource', key: 'queue:RQ-CLI-RES',
      owner: 'dot-main', sourceId: 'res-1', ...lease }).status).toBe('acquired');
    expect(acquireCoordination({ root: cliRoot, origin: 'message', key: 'queue:cli-msg-1',
      owner: 'nova', sourceId: 'msg-1:1:1', ...lease }).status).toBe('acquired');
    expect(acquireCoordination({ root: cliRoot, origin: 'board', key: 'board:cli-item',
      owner: 'board-op', sourceId: 'cli-item', ...lease }).status).toBe('acquired');

    const all = await cli(['claim', 'list']);
    expect(all.code).toBe(0);
    expect(all.json.claims.map((row: { origin: string }) => row.origin).sort())
      .toEqual(['board', 'message', 'resource']);

    const messages = await cli(['claim', 'list', '--origin', 'message']);
    expect(messages.code).toBe(0);
    expect(messages.json.claims).toEqual([expect.objectContaining({ origin: 'message', key: 'queue:cli-msg-1' })]);

    const resources = await cli(['claim', 'list', '--origin', 'resource']);
    expect(resources.code).toBe(0);
    expect(resources.json.claims).toEqual([expect.objectContaining({ origin: 'resource', key: 'queue:RQ-CLI-RES' })]);

    const human = await cli(['claim', 'list', '--origin', 'board'], {}, false);
    expect(human.code).toBe(0);
    expect(human.text).toContain('board:cli-item owner=board-op origin=board');

    // 'queue' is a read-only path-observation class, never a stored claim origin.
    expect(await cli(['claim', 'list', '--origin', 'bogus'])).toMatchObject({ code: 2 });
    expect(await cli(['claim', 'list', '--origin', 'queue'])).toMatchObject({ code: 2 });
  });

  it('filters claim list by --exclude-owner and --contains', async () => {
    const now = Date.now();
    const lease = { leaseMs: 600_000, leaseUntil: now + 600_000, now };
    expect(acquireCoordination({ root: cliRoot, origin: 'resource', key: 'queue:RQ-CLI-RES',
      owner: 'dot-main', sourceId: 'res-1', ...lease }).status).toBe('acquired');
    expect(acquireCoordination({ root: cliRoot, origin: 'message', key: 'queue:cli-msg-1',
      owner: 'nova', sourceId: 'msg-1:1:1', ...lease }).status).toBe('acquired');
    expect(acquireCoordination({ root: cliRoot, origin: 'board', key: 'board:cli-item',
      owner: 'board-op', sourceId: 'cli-item', ...lease }).status).toBe('acquired');

    const others = await cli(['claim', 'list', '--exclude-owner', 'dot-main']);
    expect(others.code).toBe(0);
    expect(others.json.claims.map((row: { owner: string }) => row.owner).sort()).toEqual(['board-op', 'nova']);
    expect(others.json.excludeOwner).toMatchObject({ ref: 'dot-main', registry: 'missing' });

    const text = await cli(['claim', 'list', '--contains', 'cli-msg']);
    expect(text.code).toBe(0);
    expect(text.json.claims).toEqual([expect.objectContaining({ key: 'queue:cli-msg-1' })]);

    const human = await cli(['claim', 'list', '--exclude-owner', 'dot-main'], {}, false);
    expect(human.code).toBe(0);
    expect(human.text).toContain('excludeOwner=dot-main');

    // Both new flags validate like the rest of the read.
    expect(await cli(['claim', 'list', '--exclude-owner', 'bad owner'])).toMatchObject({ code: 2 });
    expect(await cli(['claim', 'list', '--contains', ''])).toMatchObject({ code: 2 });
  });
});
