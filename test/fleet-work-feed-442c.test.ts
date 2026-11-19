import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectBusWorkFeedView, readBusWorkFeed, type BusWorkFeedReadResult } from '../src/core/agents/bus-work-feed-read.js';
import type { WorkJob } from '../src/core/agents/bus-v2-schema.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetWorkFeed } from '../src/cli/fleet-work-feed.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const post = { kind: 'work.post', jobId: 'fake-job', title: 'Review', repo: 'fake/repo',
  claimKeys: ['repo:fake/repo'], provider: 'devin' };
const envelope = (body: unknown, cursor = 1, from = 'fake-agent') => ({
  id: `fake-message-${cursor}`, from, to: 'leaders', priority: 'P2', ttl: 1000, body,
});
let root: string, now: number;
const append = (body: unknown, cursor = 1, from = 'fake-agent') => {
  expect(appendBusInbox(envelope(body, cursor, from), { root, now: () => now }).status).toBe('posted');
};
const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-feed-442c-'));
  chmodSync(root, 0o700);
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('bus work feed reader and CLI', { timeout: 60_000 }, () => {
  it('is registered under the fleet naming convention', () => {
    expect(resolveFleetSubcommand('work-feed')).toEqual({ module: './fleet-work-feed.js', exportName: 'cmdFleetWorkFeed' });
  });

  it('reads empty and missing inboxes without creating files, and prints jobs=0', async () => {
    const log = output();
    for (const directory of [root, join(root, 'missing')]) {
      expect(readBusWorkFeed({ root: directory })).toEqual({ status: 'ok', jobs: [], receipts: 0, asOf: new Date(now).toISOString() });
      expect(await cmdFleetWorkFeed(['--root', directory])).toBe(0);
      expect(log.mock.calls.at(-1)?.[0]).toBe(`jobs=0 receipts=0 feed=ok as-of=${new Date(now).toISOString()}`);
    }
  });

  it('resolves omitted providers through the identity registry newest runtime', () => {
    const { provider: _provider, ...withoutProvider } = post;
    append(withoutProvider, 1, 'agent:worker-bot');
    append({ ...withoutProvider, jobId: 'fake-alias-job' }, 2, 'lane-7');
    // Labels that resolve to no identity keep provider unknown: still refused.
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'refused', reason: 'missing-provider', receipts: 2 });
    expect(registerAgentIdentity({ handle: 'worker-bot', aliases: ['lane-7'],
      runtime: { cli: 'codex', provider: 'codex-cmp', model: null } }, { root, now: () => now }).status).toBe('created');
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'ok', jobs: [
      { id: post.jobId, owner: 'agent:worker-bot', provider: 'codex-cmp' },
      { id: 'fake-alias-job', owner: 'lane-7', provider: 'codex-cmp' }] });
    // The newest runtime's provider is the hint; an explicit post provider still wins.
    registerAgentIdentity({ handle: 'worker-bot', runtime: { cli: 'devin', provider: 'devin', model: null } },
      { root, now: () => now + 1_000 });
    append({ ...withoutProvider, provider: 'claude', jobId: 'fake-explicit' }, 3, 'agent:worker-bot');
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'ok', jobs: [
      { id: post.jobId, provider: 'devin' }, { id: 'fake-alias-job', provider: 'devin' },
      { id: 'fake-explicit', provider: 'claude' }] });
    // An injected provider fallback replaces the registry hint.
    expect(readBusWorkFeed({ root, providerFor: () => 'glm' })).toMatchObject({ status: 'ok',
      jobs: [{ provider: 'glm' }, { provider: 'glm' }, { provider: 'claude' }] });
  });

  it('applies owner status updates, sorts newest first and filters text and JSON', async () => {
    append(post);
    now += 10;
    append({ ...post, jobId: 'fake-second' }, 2);
    now += 10;
    append({ kind: 'work.status', jobId: post.jobId, status: 'running' }, 3);
    const result = readBusWorkFeed({ root });
    expect(result).toMatchObject({ status: 'ok', receipts: 3, jobs: [{ id: post.jobId, status: 'running', updatedAt: now },
      { id: 'fake-second', status: 'queued', updatedAt: now - 10 }] });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toBe(`fake-job running owner=fake-agent provider=devin repo=fake/repo updated=${new Date(now).toISOString()}`);
    expect(log.mock.calls[1]?.[0]).toContain('fake-second queued');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--status', 'queued'])).toBe(0);
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls[0]?.[0]).toContain('fake-second queued');
    expect(log.mock.calls[1]?.[0]).toContain('jobs=1 receipts=3 feed=ok');
    expect(await cmdFleetWorkFeed(['--root', root, '--status', 'running', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ...result, jobs: result.status === 'ok' ? result.jobs.filter(job => job.status === 'running') : [],
    });
  });

  it('refuses a status from a different owner and exits 1 in text and JSON', async () => {
    append(post);
    append({ kind: 'work.status', jobId: post.jobId, status: 'done' }, 2, 'fake-other');
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'refused', reason: 'owner-mismatch', receipts: 2 });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(1);
    expect(log.mock.calls).toHaveLength(1);
    expect(log.mock.calls[0]?.[0]).toContain('jobs=unknown receipts=2 feed=refused:owner-mismatch');
    expect(await cmdFleetWorkFeed(['--root', root, '--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'refused', reason: 'owner-mismatch' });
  });

  it('pages through 130 real posts and leaves the original journal unchanged', () => {
    for (let i = 1; i <= 130; i++) append({ ...post, jobId: `fake-job-${i}` }, i);
    const file = join(root, 'bus-inbox', 'messages.json');
    const before = readFileSync(file, 'utf8');
    now += 500;
    const result = readBusWorkFeed({ root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('fixture refused');
    expect(result.receipts).toBe(130);
    expect(result.jobs.map(job => job.id)).toEqual(Array.from({ length: 130 }, (_, i) => `fake-job-${i + 1}`));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('reports an unreadable inbox and prints a failure footer with exit 1', async () => {
    append(post);
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), 'invalid JSON');
    expect(readBusWorkFeed({ root })).toEqual({ status: 'unavailable', asOf: new Date(now).toISOString() });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(1);
    expect(log.mock.calls[0]?.[0]).toContain('jobs=unknown receipts=unknown feed=unavailable');
  });

  it('joins live coordination holds with --claims and keeps hold state honest', async () => {
    append(post);
    const claim = { root, origin: 'resource' as const, key: 'repo:fake/repo', owner: 'fake-holder',
      leaseMs: 60_000, leaseUntil: now + 60_000, sourceId: 'work:fake-claim', now };
    expect(acquireCoordination(claim).status).toBe('acquired');
    const held = readBusWorkFeed({ root, claims: true });
    expect(held).toMatchObject({ status: 'ok', claims: { source: 'available', truncated: false,
      holds: [{ jobId: post.jobId, claimKey: 'repo:fake/repo', owner: 'fake-holder',
        origin: 'resource', sourceId: 'work:fake-claim' }] } });
    expect(JSON.stringify(held)).not.toContain('token');
    const plain = readBusWorkFeed({ root });
    expect(plain.status === 'ok' && plain.claims).toBeUndefined();
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root, '--claims'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith(`held ${post.jobId} repo:fake/repo owner=fake-holder`))).toBe(true);
    expect(log.mock.calls.at(-1)?.[0]).toContain('claims=available');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--claims', '--status', 'done', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'ok', jobs: [],
      claims: { source: 'available', holds: [] } });
    rmSync(join(root, 'coordination'), { recursive: true, force: true });
    mkdirSync(join(root, 'coordination'), { mode: 0o700 });
    writeFileSync(join(root, 'coordination', 'claims.json'), 'invalid JSON');
    expect(readBusWorkFeed({ root, claims: true })).toMatchObject({ status: 'ok',
      claims: { source: 'unavailable', holds: [] } });
    rmSync(join(root, 'coordination'), { recursive: true, force: true });
    expect(readBusWorkFeed({ root, claims: true })).toMatchObject({ status: 'ok',
      claims: { source: 'missing', holds: [] } });
  });

  it('filters to jobs still open for a worker with --open and implies the claims join', async () => {
    const hold = (key: string, sourceId: string) => {
      expect(acquireCoordination({ root, origin: 'resource', key, owner: 'fake-holder',
        leaseMs: 60_000, leaseUntil: now + 60_000, sourceId, now }).status).toBe('acquired');
    };
    // queued with every key free -> open
    append({ ...post, jobId: 'fake-open', claimKeys: ['queue:RQ-OPEN', 'repo:fake/repo'] });
    // queued with its only key held -> closed
    append({ ...post, jobId: 'fake-held', claimKeys: ['queue:RQ-HELD'] }, 2);
    hold('queue:RQ-HELD', 'work:fake-held');
    // queued with one of two keys held -> still open on the free key
    append({ ...post, jobId: 'fake-part', claimKeys: ['queue:RQ-PART-A', 'queue:RQ-PART-B'] }, 3);
    hold('queue:RQ-PART-A', 'work:fake-part');
    // queued with no claim keys -> nothing to acquire
    append({ ...post, jobId: 'fake-nokeys', claimKeys: [] }, 4);
    // running and done are not open statuses even with free keys
    append({ ...post, jobId: 'fake-running' }, 5);
    append({ kind: 'work.status', jobId: 'fake-running', status: 'running' }, 6);
    append({ ...post, jobId: 'fake-done' }, 7);
    append({ kind: 'work.status', jobId: 'fake-done', status: 'done' }, 8);
    // rescheduled is still open for a worker
    append({ ...post, jobId: 'fake-resched' }, 9);
    append({ kind: 'work.status', jobId: 'fake-resched', status: 'rescheduled' }, 10);

    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root, '--open', '--json'])).toBe(0);
    const view = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(view.status).toBe('ok');
    // --open implied the claims join even though --claims was not passed.
    expect(view.claims).toMatchObject({ source: 'available', truncated: false });
    expect(view.jobs.map((job: { id: string }) => job.id).sort())
      .toEqual(['fake-open', 'fake-part', 'fake-resched']);
    // Holds regroup under shown jobs only: the hidden fake-held lease is dropped,
    // the partial fake-part lease stays.
    expect(view.claims.holds).toEqual([expect.objectContaining({ jobId: 'fake-part', claimKey: 'queue:RQ-PART-A' })]);
    expect(JSON.stringify(view)).not.toContain('token');

    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--open'])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.startsWith('fake-open queued'))).toBe(true);
    expect(lines.some(line => line.startsWith('fake-part queued'))).toBe(true);
    expect(lines.some(line => line.startsWith('fake-resched rescheduled'))).toBe(true);
    expect(lines.some(line => line.startsWith('fake-held'))).toBe(false);
    expect(lines.some(line => line.startsWith('fake-running'))).toBe(false);
    expect(lines.at(-1)).toContain('claims=available');

    // --open composes with --status as an intersection.
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--open', '--status', 'rescheduled', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).jobs.map((job: { id: string }) => job.id))
      .toEqual(['fake-resched']);
    expect(await cmdFleetWorkFeed(['--root', root, '--open', '--status', 'done', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).jobs).toEqual([]);
  });

  it('keeps open candidates rather than proving them closed when holds are unknown', async () => {
    append({ ...post, jobId: 'fake-open', claimKeys: ['queue:RQ-OPEN'] });
    append({ ...post, jobId: 'fake-held', claimKeys: ['queue:RQ-HELD'] }, 2);
    expect(acquireCoordination({ root, origin: 'resource', key: 'queue:RQ-HELD', owner: 'fake-holder',
      leaseMs: 60_000, leaseUntil: now + 60_000, sourceId: 'work:fake-held', now }).status).toBe('acquired');
    append({ ...post, jobId: 'fake-nokeys', claimKeys: [] }, 3);
    const log = output();

    // An unreadable coordination table means holds are unknown: every open-status
    // job with claim keys stays a candidate, including the fully held one.
    mkdirSync(join(root, 'coordination'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'coordination', 'claims.json'), 'invalid JSON');
    expect(await cmdFleetWorkFeed(['--root', root, '--open', '--json'])).toBe(0);
    const blind = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(blind.claims).toMatchObject({ source: 'unavailable', holds: [] });
    expect(blind.jobs.map((job: { id: string }) => job.id).sort()).toEqual(['fake-held', 'fake-open']);

    // A verified-empty table is known state, not unknown: every declared key is
    // free. Removing the directory drops the hold itself, so the same jobs list
    // — but now proven open rather than candidates, as claims.source shows.
    rmSync(join(root, 'coordination'), { recursive: true, force: true });
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--open', '--json'])).toBe(0);
    const empty = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(empty.claims).toMatchObject({ source: 'missing', holds: [] });
    expect(empty.jobs.map((job: { id: string }) => job.id).sort()).toEqual(['fake-held', 'fake-open']);
  });

  it('treats truncated or absent hold joins as unknown candidates for --open', () => {
    const job = (id: string, status: WorkJob['status'], claimKeys: string[]): WorkJob =>
      ({ id, owner: 'fake-agent', provider: 'devin', repo: 'fake/repo', claimKeys, status, updatedAt: now });
    const base: BusWorkFeedReadResult = { status: 'ok', receipts: 2, asOf: new Date(now).toISOString(),
      jobs: [job('fake-a', 'queued', ['queue:RQ-A']), job('fake-b', 'queued', ['queue:RQ-B'])] };
    const ids = (result: BusWorkFeedReadResult) => result.status === 'ok' ? result.jobs.map(j => j.id) : [];
    // A truncated hold list cannot prove a job closed: both stay candidates.
    const truncated = projectBusWorkFeedView({ ...base, claims: { source: 'available', truncated: true,
      holds: [{ jobId: 'fake-a', claimKey: 'queue:RQ-A', owner: 'fake-holder', leaseUntil: now + 1,
        origin: 'resource', sourceId: 'work:x' }] } }, undefined, true);
    expect(ids(truncated)).toEqual(['fake-a', 'fake-b']);
    // No claims join at all is likewise unknown, never proven free or closed.
    expect(ids(projectBusWorkFeedView(base, undefined, true))).toEqual(['fake-a', 'fake-b']);
    // A verified-empty table proves every key free: both are open, not candidates.
    const missing = projectBusWorkFeedView({ ...base, claims: { source: 'missing', truncated: false, holds: [] } },
      undefined, true);
    expect(ids(missing)).toEqual(['fake-a', 'fake-b']);
    expect(missing.status === 'ok' && missing.claims?.source).toBe('missing');
  });

  it('rejects relative roots and invalid flags with usage on stderr and exit 2', async () => {
    const log = output();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', 'relative/path'], ['--status', 'unknown'], ['--root'],
      ['--status', 'queued', '--status', 'done'], ['--json', '--json'], ['--claims', '--claims'],
      ['--open', '--open'], ['--bogus']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(8);
    expect(error.mock.calls[0]?.[0]).toContain('Usage: ashlr fleet work-feed');
    expect(await cmdFleetWorkFeed(['--help'])).toBe(0);
  });
});

describe('work-feed owner matching through the identity registry', () => {
  it('lets one identity status its job from any registered label, and refuses other identities', () => {
    append(post, 1, 'agent:worker-bot');
    append({ kind: 'work.status', jobId: post.jobId, status: 'running' }, 2, 'lane-7');
    // No registry yet: sibling labels are different routing owners, feed refuses.
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'refused', reason: 'owner-mismatch', receipts: 2 });
    expect(registerAgentIdentity({ handle: 'worker-bot', aliases: ['lane-7'],
      runtime: { cli: 'codex', provider: 'codex-cmp', model: null } }, { root, now: () => now }).status).toBe('created');
    // Handle address and alias now name one owner; the job keeps its posting label.
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'ok',
      jobs: [{ id: post.jobId, owner: 'agent:worker-bot', status: 'running' }] });
    // A different registered identity still cannot move the job.
    expect(registerAgentIdentity({ handle: 'other-bot',
      runtime: { cli: 'devin', provider: 'devin', model: null } }, { root, now: () => now }).status).toBe('created');
    append({ kind: 'work.status', jobId: post.jobId, status: 'done' }, 3, 'agent:other-bot');
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'refused', reason: 'owner-mismatch', receipts: 3 });
    // An injected ownerKeyFor replaces the registry fallback entirely.
    expect(readBusWorkFeed({ root, ownerKeyFor: () => 'same-owner' })).toMatchObject({ status: 'ok',
      jobs: [{ id: post.jobId, status: 'done' }] });
  });
});
