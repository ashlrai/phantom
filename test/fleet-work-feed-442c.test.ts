import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { busWorkFeedJobHold, projectBusWorkFeedView, readBusWorkFeed, type BusWorkFeedJob, type BusWorkFeedReadResult } from '../src/core/agents/bus-work-feed-read.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetWorkFeed } from '../src/cli/fleet-work-feed.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const post = { kind: 'work.post', jobId: 'fake-job', title: 'Review', repo: 'fake/repo',
  claimKeys: ['repo:fake/repo'], provider: 'devin' };
const envelope = (body: unknown, cursor = 1, from = 'fake-agent', to = 'leaders') => ({
  id: `fake-message-${cursor}`, from, to, priority: 'P2', ttl: 1000, body,
});
let root: string, now: number;
const append = (body: unknown, cursor = 1, from = 'fake-agent', to = 'leaders') => {
  expect(appendBusInbox(envelope(body, cursor, from, to), { root, now: () => now }).status).toBe('posted');
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
    // Labels that resolve to no identity keep provider unknown: still refused,
    // and the refusal names the first retained receipt that lacked a provider.
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'refused', reason: 'missing-provider', receipts: 2,
      receipt: { id: 'fake-message-1', receivedAt: now, ttl: 1000 } });
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
    expect(result).toMatchObject({ status: 'ok', receipts: 3, jobs: [
      { id: post.jobId, status: 'running', updatedAt: now, postId: 'fake-message-1', statusId: 'fake-message-3' },
      { id: 'fake-second', status: 'queued', updatedAt: now - 10, postId: 'fake-message-2', statusId: null }] });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toBe(`fake-job running "Review" owner=fake-agent to=leaders provider=devin repo=fake/repo keys=repo:fake/repo updated=${new Date(now).toISOString()} post=fake-message-1 status=fake-message-3`);
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

  it('scrubs and clips the title and claim keys on human lines while JSON keeps them', async () => {
    const dirty = `Fix\n  the\tfake sk-ant-api03-${'a'.repeat(40)} ${'t'.repeat(170)}`;
    const claimKeys = ['repo:fake/repo',
      ...Array.from({ length: 4 }, (_, i) => `queue:key-${i}-${'k'.repeat(110)}`)];
    append({ ...post, title: dirty, claimKeys });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(0);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('"Fix the fake [REDACTED]');
    expect(line).not.toContain('sk-ant-api03');
    expect(line).toContain('…');
    const keysField = /keys=(\S+) updated=/.exec(line)?.[1] ?? '';
    expect(keysField.length).toBeLessThanOrEqual(480);
    expect(keysField.endsWith('…')).toBe(true);
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--json'])).toBe(0);
    const wire = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { jobs: { title: string; claimKeys: string[] }[] };
    expect(wire.jobs[0]?.title).toBe(dirty);
    expect(wire.jobs[0]?.claimKeys).toEqual(claimKeys);
  });

  it('renders the newest status detail scrubbed and single-lined while JSON keeps it', async () => {
    append(post);
    now += 10;
    const dirty = `blocked\n  on\tsk-ant-api03-${'a'.repeat(40)} ${'x'.repeat(260)}`;
    append({ kind: 'work.status', jobId: post.jobId, status: 'blocked', detail: dirty }, 2);
    const result = readBusWorkFeed({ root });
    expect(result).toMatchObject({ status: 'ok', jobs: [{ id: post.jobId, status: 'blocked', detail: dirty }] });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(0);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('blocked "Review" detail="blocked on [REDACTED]');
    expect(line).not.toContain('sk-ant-api03');
    const detailField = /detail="([^"]*)"/.exec(line)?.[1] ?? '';
    expect(detailField.length).toBeLessThanOrEqual(200);
    expect(detailField.endsWith('…')).toBe(true);
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--json'])).toBe(0);
    const wire = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { jobs: { detail?: string }[] };
    expect(wire.jobs[0]?.detail).toBe(dirty);
    // A later status without detail drops the field from the human line too.
    now += 10;
    append({ kind: 'work.status', jobId: post.jobId, status: 'running' }, 3);
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).not.toContain('detail=');
  });

  it('carries the newest work.result citation onto the job and its human line', async () => {
    append(post);
    now += 10;
    append({ kind: 'work.status', jobId: post.jobId, status: 'running' }, 2);
    now += 10;
    append({ kind: 'work.result', jobId: post.jobId, claimKey: 'repo:fake/repo',
      queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'complete', reason: 'paths-not-allowed' }, 3, 'fake-worker');
    const result = readBusWorkFeed({ root });
    // The report is evidence on the citation — the job's status stays the
    // announcer's 'running', never the result's 'complete'.
    expect(result).toMatchObject({ status: 'ok', jobs: [{ id: post.jobId, status: 'running',
      result: { id: 'fake-message-3', from: 'fake-worker', outcome: 'complete',
        reason: 'paths-not-allowed' } }] });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      'result=complete reason=paths-not-allowed by=fake-worker');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--json'])).toBe(0);
    const wire = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { jobs: { result?: { id: string } }[] };
    expect(wire.jobs[0]?.result?.id).toBe('fake-message-3');
  });

  it('refuses a status from a different owner and exits 1 in text and JSON', async () => {
    append(post);
    append({ kind: 'work.status', jobId: post.jobId, status: 'done' }, 2, 'fake-other');
    // The foreign status receipt is the one the projection blames.
    expect(readBusWorkFeed({ root })).toMatchObject({ status: 'refused', reason: 'owner-mismatch', receipts: 2,
      receipt: { id: 'fake-message-2', receivedAt: now, ttl: 1000 } });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(1);
    expect(log.mock.calls).toHaveLength(1);
    expect(log.mock.calls[0]?.[0]).toContain('jobs=unknown receipts=2 feed=refused:owner-mismatch receipt=fake-message-2');
    expect(await cmdFleetWorkFeed(['--root', root, '--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'refused', reason: 'owner-mismatch',
      receipt: { id: 'fake-message-2', receivedAt: now, ttl: 1000 } });
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

  it('annotates open jobs with per-key hold coverage under --claims and leaves other jobs bare', () => {
    append(post); // fake-job queued, keys ['repo:fake/repo']
    append({ ...post, jobId: 'fake-free', claimKeys: ['repo:fake/repo', 'queue:fake-free'] }, 2);
    append({ ...post, jobId: 'fake-running', claimKeys: ['queue:fake-running'] }, 3);
    append({ kind: 'work.status', jobId: 'fake-running', status: 'running' }, 4);
    const claim = { root, origin: 'resource' as const, key: 'repo:fake/repo', owner: 'fake-holder',
      leaseMs: 60_000, leaseUntil: now + 60_000, sourceId: 'work:fake-claim', now };
    expect(acquireCoordination(claim).status).toBe('acquired');

    const held = readBusWorkFeed({ root, claims: true });
    expect(held.status).toBe('ok');
    if (held.status !== 'ok') throw new Error('fixture refused');
    const byId = new Map(held.jobs.map(job => [job.id, job]));
    // Every declared key held: provably not claimable.
    expect(byId.get(post.jobId)).toMatchObject({ claimable: false, heldKeys: ['repo:fake/repo'], freeKeys: [] });
    // One key held, one provably free under complete coverage.
    expect(byId.get('fake-free')).toMatchObject({ claimable: true, heldKeys: ['repo:fake/repo'],
      freeKeys: ['queue:fake-free'] });
    // Non-open jobs keep no claim annotation — claimable has no meaning off the open set.
    expect(byId.get('fake-running')).not.toHaveProperty('claimable');
    expect(byId.get('fake-running')).not.toHaveProperty('freeKeys');
    expect(byId.get('fake-running')).not.toHaveProperty('heldKeys');
    // Without the claims join the fields stay absent entirely.
    const plain = readBusWorkFeed({ root });
    if (plain.status !== 'ok') throw new Error('fixture refused');
    expect(plain.jobs.every(job => !('claimable' in job))).toBe(true);
  });

  it('reports provably-free keys on a missing table and unknown coverage on an unreadable one', () => {
    append(post);
    // No coordination store at all: verified empty, so every declared key is free.
    const missing = readBusWorkFeed({ root, claims: true });
    expect(missing).toMatchObject({ status: 'ok', claims: { source: 'missing' },
      jobs: [{ claimable: true, heldKeys: [], freeKeys: ['repo:fake/repo'] }] });
    // An unreadable table means hold state is unknown, never a free set.
    mkdirSync(join(root, 'coordination'), { mode: 0o700 });
    writeFileSync(join(root, 'coordination', 'claims.json'), 'invalid JSON');
    const unreadable = readBusWorkFeed({ root, claims: true });
    expect(unreadable).toMatchObject({ status: 'ok', claims: { source: 'unavailable' },
      jobs: [{ claimable: null, heldKeys: null, freeKeys: null }] });
  });

  it('keeps claimable honest when the hold list truncates', () => {
    append(post, 1, 'fake-agent', 'leaders'); // fake-job — fills the hold cap first
    append({ ...post, jobId: 'fake-late', claimKeys: ['repo:fake/repo', 'repo:fake/other'] }, 2);
    // 1024 live rows all blocking repo:fake/repo — the store maximum — so the
    // first job's pairs fill HOLDS_MAX exactly and the second job's are cut.
    const claims = Array.from({ length: 1024 }, (_, i) => ({
      origin: 'resource', key: 'repo:fake/repo', owner: `fake-holder-${i}`, token: 'a'.repeat(64),
      leaseMs: 60_000, leaseUntil: now + 60_000, state: 'live', sourceId: `work:fake-${i}`,
      repo: null, branch: null, path: null,
    }));
    mkdirSync(join(root, 'coordination'), { mode: 0o700 });
    writeFileSync(join(root, 'coordination', 'claims.json'),
      JSON.stringify({ version: 1, claims, statuses: [] }));

    const result = readBusWorkFeed({ root, claims: true });
    expect(result).toMatchObject({ status: 'ok', claims: { source: 'available', truncated: true } });
    if (result.status !== 'ok') throw new Error('fixture refused');
    const byId = new Map(result.jobs.map(job => [job.id, job]));
    // Shown holds are real: every declared key of the first job is provably held.
    expect(byId.get(post.jobId)).toMatchObject({ claimable: false, heldKeys: ['repo:fake/repo'], freeKeys: null });
    // The second job's holds were cut before any showed: nothing is provable.
    expect(byId.get('fake-late')).toMatchObject({ claimable: null, heldKeys: [], freeKeys: null });
  });

  it('prints claimable=yes|no|unknown on annotated job lines', async () => {
    append(post);
    append({ ...post, jobId: 'fake-free', claimKeys: ['repo:fake/repo', 'queue:fake-free'] }, 2);
    const claim = { root, origin: 'resource' as const, key: 'repo:fake/repo', owner: 'fake-holder',
      leaseMs: 60_000, leaseUntil: now + 60_000, sourceId: 'work:fake-claim', now };
    expect(acquireCoordination(claim).status).toBe('acquired');
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root, '--claims'])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.startsWith(`${post.jobId} queued`) && line.includes('claimable=no'))).toBe(true);
    expect(lines.some(line => line.startsWith('fake-free queued') && line.includes('claimable=yes'))).toBe(true);
    log.mockClear();
    mkdirSync(join(root, 'coordination'), { recursive: true });
    writeFileSync(join(root, 'coordination', 'claims.json'), 'invalid JSON');
    expect(await cmdFleetWorkFeed(['--root', root, '--claims'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('claimable=unknown'))).toBe(true);
  });

  it('filters jobs by --since on last activity and refuses bad cutoffs', async () => {
    // The default fixture ttl is 1s; these receipts must outlive the minute-scale gaps.
    const appendLive = (body: unknown, cursor: number) => {
      expect(appendBusInbox({ id: `fake-live-${cursor}`, from: 'fake-agent', to: 'leaders',
        priority: 'P2', ttl: 86_400_000, body }, { root, now: () => now }).status).toBe('posted');
    };
    appendLive(post, 1);                            // fake-job announced at now
    now += 120_000;
    appendLive({ ...post, jobId: 'fake-new' }, 2);  // fake-new announced two minutes later
    const log = output();
    // An epoch-ms cutoff between the two announcement times keeps only the newer job.
    expect(await cmdFleetWorkFeed(['--root', root, '--since', String(now - 60_000)])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith('fake-new queued'))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).startsWith(`${post.jobId} queued`))).toBe(false);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=1 receipts=2 feed=ok');
    log.mockClear();
    // The phm messages grammar resolves the same way: 1m back still drops the stale job.
    expect(await cmdFleetWorkFeed(['--root', root, '--since', '1m'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith('fake-new queued'))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).startsWith(`${post.jobId} queued`))).toBe(false);
    log.mockClear();
    // A status moves the older job's last activity to now — it re-enters the window.
    now += 10_000;
    appendLive({ kind: 'work.status', jobId: post.jobId, status: 'running' }, 3);
    expect(await cmdFleetWorkFeed(['--root', root, '--since', '1m'])).toBe(0);
    const active = log.mock.calls.map(call => String(call[0])).filter(line => line.includes('queued') || line.includes('running'));
    expect(active.some(line => line.startsWith(`${post.jobId} running`))).toBe(true);
    expect(active.some(line => line.startsWith('fake-new queued'))).toBe(true);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=2 receipts=3 feed=ok');
    log.mockClear();
    // A future cutoff keeps none; epoch 0 keeps everything.
    expect(await cmdFleetWorkFeed(['--root', root, '--since', String(now + 3_600_000)])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0 receipts=3 feed=ok');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--since', '0'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=2 receipts=3 feed=ok');
    // Unparseable and duplicate cutoffs are usage errors, never silently widened.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', root, '--since', 'bogus'], ['--root', root, '--since', '1m', '--since', '2m'],
      ['--root', root, '--since'], ['--root', root, '--since', '--json']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(error).toHaveBeenCalledTimes(4);
  });

  it('filters jobs by --before on last activity and refuses bad cutoffs', async () => {
    const appendLive = (body: unknown, cursor: number) => {
      expect(appendBusInbox({ id: `fake-live-${cursor}`, from: 'fake-agent', to: 'leaders',
        priority: 'P2', ttl: 86_400_000, body }, { root, now: () => now }).status).toBe('posted');
    };
    appendLive(post, 1);                            // fake-job announced at now
    const first = now;
    now += 120_000;
    appendLive({ ...post, jobId: 'fake-new' }, 2);  // fake-new announced two minutes later
    const log = output();
    // An epoch-ms cutoff between the two announcement times keeps only the older job.
    expect(await cmdFleetWorkFeed(['--root', root, '--before', String(now - 60_000)])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith(`${post.jobId} queued`))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).startsWith('fake-new queued'))).toBe(false);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=1 receipts=2 feed=ok');
    log.mockClear();
    // The shared grammar resolves the same way: 1m back still drops the newer job.
    expect(await cmdFleetWorkFeed(['--root', root, '--before', '1m'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith(`${post.jobId} queued`))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).startsWith('fake-new queued'))).toBe(false);
    log.mockClear();
    // The bound is exclusive: the older job's own updatedAt drops it out too.
    expect(await cmdFleetWorkFeed(['--root', root, '--before', String(first)])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0 receipts=2 feed=ok');
    log.mockClear();
    // since/before read one [since, before) window — the older job alone sits inside.
    expect(await cmdFleetWorkFeed(['--root', root, '--since', String(first), '--before', String(now)])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith(`${post.jobId} queued`))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).startsWith('fake-new queued'))).toBe(false);
    log.mockClear();
    // A status moves the older job's last activity past the bound — only the
    // never-statused job stays under it.
    now += 10_000;
    appendLive({ kind: 'work.status', jobId: post.jobId, status: 'running' }, 3);
    expect(await cmdFleetWorkFeed(['--root', root, '--before', String(now - 5_000)])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith(`${post.jobId} running`))).toBe(false);
    expect(log.mock.calls.some(call => String(call[0]).startsWith('fake-new queued'))).toBe(true);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=1 receipts=3 feed=ok');
    // Unparseable and duplicate cutoffs are usage errors, never silently widened.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', root, '--before', 'bogus'], ['--root', root, '--before', '1m', '--before', '2m'],
      ['--root', root, '--before'], ['--root', root, '--before', '--json']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(error).toHaveBeenCalledTimes(4);
  });

  it('pages the feed with --limit and reports matched/omitted honestly', async () => {
    append(post);                                   // fake-job announced first
    now += 10;
    append({ ...post, jobId: 'fake-second' }, 2);
    now += 10;
    append({ ...post, jobId: 'fake-third' }, 3);
    const log = output();
    // Newest first: the page keeps the view's order and counts the rest.
    expect(await cmdFleetWorkFeed(['--root', root, '--limit', '2', '--json'])).toBe(0);
    const wire = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      jobs: { id: string }[]; matched: number; omitted: number };
    expect(wire.jobs.map(job => job.id)).toEqual(['fake-third', 'fake-second']);
    expect(wire).toMatchObject({ matched: 3, omitted: 1 });
    log.mockClear();
    // The human footer names the page; holds would regroup under shown jobs too.
    expect(await cmdFleetWorkFeed(['--root', root, '--limit', '2', '--claims'])).toBe(0);
    const footer = String(log.mock.calls.at(-1)?.[0]);
    expect(footer).toContain('jobs=2 receipts=3 feed=ok');
    expect(footer).toContain('matched=3 omitted=1');
    // A page wider than the match reports zero omitted; no --limit pages nothing.
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--limit', '200'])).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('matched=3 omitted=0');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root])).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).not.toContain('matched=');
    // Out-of-range, malformed and duplicate limits are usage errors, never a silent widen.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', root, '--limit', '0'], ['--root', root, '--limit', '201'],
      ['--root', root, '--limit', 'abc'], ['--root', root, '--limit', '1.5'], ['--root', root, '--limit', '-1'],
      ['--root', root, '--limit', '2', '--limit', '3'], ['--root', root, '--limit']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(error).toHaveBeenCalledTimes(7);
  });

  it('filters jobs by --contains over title, status detail and dispatch text', async () => {
    append({ ...post, jobId: 'fake-drain', title: 'Drain the queue',
      dispatch: { tier: 'work', scope: 'Migrate the drain path', acceptance: 'Drain lands green' } }, 1);
    append({ ...post, jobId: 'fake-polish', title: 'Polish the docs' }, 2);
    now += 10;
    append({ kind: 'work.status', jobId: 'fake-polish', status: 'running', detail: 'waiting on drain review' }, 3);
    const log = output();
    // 'drain' matches the first job's title and dispatch and the second's
    // newest status detail — every descriptive field the job line renders.
    expect(await cmdFleetWorkFeed(['--root', root, '--contains', 'DRAIN'])).toBe(0);
    expect(log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('fake-'))).toEqual([
      expect.stringContaining('fake-polish running'),
      expect.stringContaining('fake-drain queued'),
    ]);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=2 receipts=3 feed=ok');
    log.mockClear();
    // A phrase only the dispatch scope carries narrows to that one job.
    expect(await cmdFleetWorkFeed(['--root', root, '--contains', 'drain path', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 'ok', jobs: [{ id: 'fake-drain' }], receipts: 3 });
    log.mockClear();
    // Whitespace collapses on both sides like every other --contains read.
    expect(await cmdFleetWorkFeed(['--root', root, '--contains', '  drain\n  lands  '])).toBe(0);
    expect(log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('fake-'))).toEqual([
      expect.stringContaining('fake-drain queued'),
    ]);
    log.mockClear();
    // A needle nothing carries is an honest empty view; ids, keys, statuses
    // and labels are structured fields, never search text.
    for (const needle of ['bogus-needle', 'fake-drain', 'running', 'repo:fake/repo', 'leaders', 'devin']) {
      expect(await cmdFleetWorkFeed(['--root', root, '--contains', needle])).toBe(0);
      expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0 receipts=3 feed=ok');
      log.mockClear();
    }
    // Blank, duplicate and overlong needles are usage errors, never a silent widen.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', root, '--contains', ''], ['--root', root, '--contains', '   '],
      ['--root', root, '--contains', 'x'.repeat(513)], ['--root', root, '--contains', 'a', '--contains', 'b'],
      ['--root', root, '--contains']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(error).toHaveBeenCalledTimes(5);
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
    expect(blind.jobs.every((job: { claimable: unknown }) => job.claimable === null)).toBe(true);
    expect(await cmdFleetWorkFeed(['--root', root, '--open', '--claimable', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).jobs).toEqual([]);

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
    const job = (id: string, status: BusWorkFeedJob['status'], claimKeys: string[]): BusWorkFeedJob =>
      ({ id, title: id, to: 'leaders', postId: id, statusId: null, owner: 'fake-agent', provider: 'devin', repo: 'fake/repo', claimKeys, status, updatedAt: now });
    const base: BusWorkFeedReadResult = { status: 'ok', receipts: 2, asOf: new Date(now).toISOString(),
      jobs: [job('fake-a', 'queued', ['queue:RQ-A']), job('fake-b', 'queued', ['queue:RQ-B'])] };
    const ids = (result: BusWorkFeedReadResult) => result.status === 'ok' ? result.jobs.map(j => j.id) : [];
    // A truncated hold list cannot prove a job closed: both stay candidates.
    const truncated = projectBusWorkFeedView({ ...base, claims: { source: 'available', truncated: true,
      holds: [{ jobId: 'fake-a', claimKey: 'queue:RQ-A', owner: 'fake-holder', leaseUntil: now + 1,
        origin: 'resource', sourceId: 'work:x' }] } }, { open: true });
    expect(ids(truncated)).toEqual(['fake-a', 'fake-b']);
    // No claims join at all is likewise unknown, never proven free or closed.
    expect(ids(projectBusWorkFeedView(base, { open: true }))).toEqual(['fake-a', 'fake-b']);
    // A verified-empty table proves every key free: both are open, not candidates.
    const missing = projectBusWorkFeedView({ ...base, claims: { source: 'missing', truncated: false, holds: [] } },
      { open: true });
    expect(ids(missing)).toEqual(['fake-a', 'fake-b']);
    expect(missing.status === 'ok' && missing.claims?.source).toBe('missing');
  });

  it('rejects relative roots and invalid flags with usage on stderr and exit 2', async () => {
    const log = output();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', 'relative/path'], ['--status', 'unknown'], ['--root'],
      ['--status', 'queued', '--status', 'done'], ['--json', '--json'], ['--claims', '--claims'], ['--open', '--open'], ['--bogus'],
      ['--to'], ['--to', 'two words'], ['--to', 'a\nb'], ['--to', 'x', '--to', 'y']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(12);
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

describe('work-feed --to announcement-address filter', () => {
  it('keeps only jobs whose post was addressed to the label, in text and JSON', async () => {
    append(post, 1, 'fake-agent', 'leaders');
    append({ ...post, jobId: 'fake-directed' }, 2, 'fake-agent', 'agent:worker-bot');
    now += 10;
    append({ kind: 'work.status', jobId: 'fake-directed', status: 'running' }, 3, 'fake-agent', 'leaders');
    const result = readBusWorkFeed({ root });
    expect(result).toMatchObject({ status: 'ok', jobs: [
      { id: 'fake-job', to: 'leaders', status: 'queued' },
      { id: 'fake-directed', to: 'agent:worker-bot', status: 'running' }] });
    const log = output();
    expect(await cmdFleetWorkFeed(['--root', root, '--to', 'agent:worker-bot'])).toBe(0);
    expect(log.mock.calls.map(call => String(call[0]))).toEqual([
      `fake-directed running "Review" owner=fake-agent to=agent:worker-bot provider=devin repo=fake/repo keys=repo:fake/repo updated=${new Date(now).toISOString()} post=fake-message-2 status=fake-message-3`,
      `jobs=1 receipts=3 feed=ok as-of=${new Date(now).toISOString()}`]);
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--to', 'leaders', '--status', 'queued', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ...result, jobs: result.status === 'ok' ? result.jobs.filter(job => job.to === 'leaders' && job.status === 'queued') : [],
    });
    // An address no post used is an honest empty view, not an error.
    expect(await cmdFleetWorkFeed(['--root', root, '--to', 'ghost'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0 receipts=3 feed=ok');
  });

  it('matches --to under every label of one agent identity and never widens on unknown identity', async () => {
    append(post, 1, 'fake-agent', 'agent:worker-bot');
    append({ ...post, jobId: 'fake-sink' }, 2, 'fake-agent', 'leaders');
    const jobLines = (calls: unknown[][]) => calls.map(call => String(call[0])).filter(line => line.startsWith('fake-'));
    const log = output();
    // No registry: only the literal announcement label matches.
    expect(await cmdFleetWorkFeed(['--root', root, '--to', 'worker-bot'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0');
    log.mockClear();
    expect(registerAgentIdentity({ handle: 'worker-bot', aliases: ['lane-7'],
      runtime: { cli: 'codex', provider: 'codex-cmp', model: null } }, { root, now: () => now }).status).toBe('created');
    for (const ref of ['worker-bot', 'agent:worker-bot', 'lane-7']) {
      log.mockClear();
      expect(await cmdFleetWorkFeed(['--root', root, '--to', ref])).toBe(0);
      expect(jobLines(log.mock.calls)).toEqual([expect.stringContaining('fake-job')]);
    }
    // The fleet sink job stays out of every identity-scoped view.
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--to', 'leaders'])).toBe(0);
    expect(jobLines(log.mock.calls)).toEqual([expect.stringContaining('fake-sink')]);
  });
});

describe('work-feed --channel room filter', () => {
  it('keeps only jobs announced to group:<channel>:* under every topic', async () => {
    append(post, 1, 'fake-agent', 'group:release:general');
    now += 10;
    append({ ...post, jobId: 'fake-room-topic' }, 2, 'fake-agent', 'group:release:deploy');
    now += 10;
    append({ ...post, jobId: 'fake-other-room' }, 3, 'fake-agent', 'group:ops:deploy');
    now += 10;
    append({ ...post, jobId: 'fake-direct' }, 4, 'fake-agent', 'agent:worker-bot');
    now += 10;
    append({ ...post, jobId: 'fake-sink' }, 5, 'fake-agent', 'leaders');
    const result = readBusWorkFeed({ root });
    expect(result).toMatchObject({ status: 'ok', receipts: 5 });
    const log = output();
    // The room's whole traffic under every topic — the same group:<name>:
    // prefix agents bus inbox --channel and channel read match.
    expect(await cmdFleetWorkFeed(['--root', root, '--channel', 'release', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 'ok', receipts: 5, jobs: [{ id: 'fake-room-topic' }, { id: 'fake-job' }] });
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--channel', 'ops'])).toBe(0);
    expect(log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('fake-')))
      .toEqual([expect.stringContaining('fake-other-room')]);
    log.mockClear();
    // A room nothing was announced to is an honest empty view, not an error.
    expect(await cmdFleetWorkFeed(['--root', root, '--channel', 'ghost'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0 receipts=5 feed=ok');
    // The prefix needs the topic separator: lookalike labels never match.
    now += 10;
    append({ ...post, jobId: 'fake-lookalike' }, 6, 'fake-agent', 'group:release2:x');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--channel', 'release', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).jobs.map((job: { id: string }) => job.id))
      .toEqual(['fake-room-topic', 'fake-job']);
  });

  it('rejects channel names outside the bus channel grammar', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', root, '--channel', 'Has Space'], ['--root', root, '--channel', 'UPPER'],
      ['--root', root, '--channel', ''], ['--root', root, '--channel', 'x'.repeat(33)],
      ['--root', root, '--channel', 'a:b'], ['--root', root, '--channel', 'release', '--channel', 'ops'],
      ['--root', root, '--channel']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(error).toHaveBeenCalledTimes(7);
  });
});

describe('work-feed --job and --owner filters', () => {
  it('keeps one job id and jobs announced by an agent label in text and JSON', async () => {
    append(post, 1, 'fake-agent');
    append({ ...post, jobId: 'fake-second' }, 2, 'lane-7');
    now += 10;
    append({ kind: 'work.status', jobId: post.jobId, status: 'running' }, 3, 'fake-agent');
    const result = readBusWorkFeed({ root });
    expect(result).toMatchObject({ status: 'ok', jobs: [
      { id: post.jobId, owner: 'fake-agent', status: 'running' },
      { id: 'fake-second', owner: 'lane-7', status: 'queued' }] });
    const log = output();
    // --job resolves the exact id through the whole lifecycle, status included.
    expect(await cmdFleetWorkFeed(['--root', root, '--job', 'fake-second'])).toBe(0);
    expect(log.mock.calls.map(call => String(call[0]))).toEqual([
      `fake-second queued "Review" owner=lane-7 to=leaders provider=devin repo=fake/repo keys=repo:fake/repo updated=${new Date(now - 10).toISOString()} post=fake-message-2`,
      `jobs=1 receipts=3 feed=ok as-of=${new Date(now).toISOString()}`]);
    log.mockClear();
    // An unknown id is an honest empty view, not an error.
    expect(await cmdFleetWorkFeed(['--root', root, '--job', 'fake-gone'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0 receipts=3 feed=ok');
    log.mockClear();
    // --owner keeps jobs announced by that label; --job composes with --status.
    expect(await cmdFleetWorkFeed(['--root', root, '--owner', 'fake-agent', '--status', 'running', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ...result, jobs: result.status === 'ok' ? result.jobs.filter(job => job.owner === 'fake-agent' && job.status === 'running') : [],
    });
    expect(await cmdFleetWorkFeed(['--root', root, '--owner', 'lane-7'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).startsWith('fake-second queued'))).toBe(true);
  });

  it('matches --owner under every label of one agent identity and never widens on unknown identity', async () => {
    append(post, 1, 'agent:worker-bot');
    append({ ...post, jobId: 'fake-sink' }, 2, 'fake-other');
    const jobLines = (calls: unknown[][]) => calls.map(call => String(call[0])).filter(line => line.startsWith('fake-'));
    const log = output();
    // No registry: only the literal announcer label matches.
    expect(await cmdFleetWorkFeed(['--root', root, '--owner', 'worker-bot'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0');
    log.mockClear();
    expect(registerAgentIdentity({ handle: 'worker-bot', aliases: ['lane-7'],
      runtime: { cli: 'codex', provider: 'codex-cmp', model: null } }, { root, now: () => now }).status).toBe('created');
    for (const ref of ['worker-bot', 'agent:worker-bot', 'lane-7']) {
      log.mockClear();
      expect(await cmdFleetWorkFeed(['--root', root, '--owner', ref])).toBe(0);
      expect(jobLines(log.mock.calls)).toEqual([expect.stringContaining('fake-job')]);
    }
    // The other announcer's job stays out of every identity-scoped view.
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--owner', 'fake-other'])).toBe(0);
    expect(jobLines(log.mock.calls)).toEqual([expect.stringContaining('fake-sink')]);
  });

  it('rejects bad --job and --owner values with usage on stderr and exit 2', async () => {
    const log = output();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--job'], ['--job', 'two words'], ['--job', 'a\nb'], ['--job', 'x', '--job', 'y'],
      ['--owner'], ['--owner', 'two words'], ['--owner', 'a\nb'], ['--owner', 'x', '--owner', 'y'],
      ['--job', 'x', '--owner', 'bad owner']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(9);
  });
});

describe('work-feed --repo, --provider and --claimable filters', () => {
  it('keeps jobs by announced repo case-insensitively and by provider, in text and JSON', async () => {
    append({ ...post, repo: 'Fake/Repo' }, 1, 'fake-agent');
    append({ ...post, jobId: 'fake-other', repo: 'fake/other', provider: 'claude',
      claimKeys: ['repo:fake/other'] }, 2, 'fake-agent');
    const log = output();
    // --repo normalizes to the lowercase claim-key slug: announced case never matters.
    const jobLines = () => log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('fake-'));
    expect(await cmdFleetWorkFeed(['--root', root, '--repo', 'fake/repo'])).toBe(0);
    expect(jobLines()).toEqual([expect.stringContaining(`${post.jobId} queued`)]);
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--repo', 'FAKE/OTHER', '--provider', 'claude', '--json'])).toBe(0);
    const json = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(json.jobs.map((job: { id: string }) => job.id)).toEqual(['fake-other']);
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--provider', 'devin'])).toBe(0);
    expect(jobLines()).toEqual([expect.stringContaining(`${post.jobId} queued`)]);
    log.mockClear();
    // An unmatched repo is an honest empty view, and filters compose.
    expect(await cmdFleetWorkFeed(['--root', root, '--repo', 'ghost/repo'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--repo', 'fake/repo', '--provider', 'claude'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0');
  });

  it('keeps only provably-claimable open jobs under --claimable, implying the claims join', async () => {
    append(post, 1, 'fake-agent'); // fake-job queued, sole key repo:fake/repo — free
    append({ ...post, jobId: 'fake-held', claimKeys: ['repo:fake/held'] }, 2, 'fake-agent');
    const claim = { root, origin: 'resource' as const, key: 'repo:fake/held', owner: 'fake-holder',
      leaseMs: 60_000, leaseUntil: now + 60_000, sourceId: 'work:fake-held-claim', now };
    expect(acquireCoordination(claim).status).toBe('acquired');
    const log = output();
    // --claimable alone performs the claims join and keeps only the free job.
    expect(await cmdFleetWorkFeed(['--root', root, '--claimable'])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.startsWith(`${post.jobId} queued`) && line.includes('claimable=yes'))).toBe(true);
    expect(lines.some(line => line.startsWith('fake-held queued'))).toBe(false);
    expect(lines.at(-1)).toContain('claims=available');
    log.mockClear();
    // It composes with the other filters and stays honest when nothing matches.
    expect(await cmdFleetWorkFeed(['--root', root, '--claimable', '--repo', 'fake/held', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'ok', jobs: [],
      claims: { source: 'available' } });
    log.mockClear();
    // Unknown hold coverage never counts as claimable: an unreadable table empties the view honestly.
    writeFileSync(join(root, 'coordination', 'claims.json'), 'invalid JSON');
    expect(await cmdFleetWorkFeed(['--root', root, '--claimable'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0');
  });

  it('rejects bad --repo, --provider and --claimable values with usage on stderr and exit 2', async () => {
    const log = output();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--repo'], ['--repo', 'no-slash'], ['--repo', 'a/b/c'], ['--repo', 'x', '--repo', 'y'],
      ['--provider'], ['--provider', 'bogus'], ['--provider', 'x', '--provider', 'y'],
      ['--claimable', '--claimable'], ['--repo', 'a/b', '--provider', 'devin', '--claimable', '--bogus']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(9);
  });
});

describe('work-feed --tier filter', () => {
  it('keeps jobs by declared dispatch tier, in text and JSON', async () => {
    append({ ...post, jobId: 'fake-fast', dispatch: { tier: 'fast', scope: 's', acceptance: 'a' } }, 1);
    append({ ...post, jobId: 'fake-work', dispatch: { tier: 'work', scope: 's', acceptance: 'a' } }, 2);
    append({ ...post, jobId: 'fake-plain' }, 3);
    const log = output();
    const jobLines = () => log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('fake-'));
    // --tier keeps only jobs whose work.post declared that dispatch tier.
    expect(await cmdFleetWorkFeed(['--root', root, '--tier', 'fast'])).toBe(0);
    expect(jobLines()).toEqual([expect.stringContaining('fake-fast queued')]);
    expect(String(log.mock.calls[0]?.[0])).toContain('tier=fast');
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=1 receipts=3 feed=ok');
    log.mockClear();
    // A job carrying no dispatch spec declares no tier and never matches.
    expect(await cmdFleetWorkFeed(['--root', root, '--tier', 'mid', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'ok', jobs: [], receipts: 3 });
    log.mockClear();
    // The filter composes with the other structured filters.
    expect(await cmdFleetWorkFeed(['--root', root, '--tier', 'work', '--provider', 'claude'])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('jobs=0');
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--tier', 'work', '--repo', 'fake/repo', '--status', 'queued'])).toBe(0);
    expect(jobLines()).toEqual([expect.stringContaining('fake-work queued')]);
  });

  it('rejects bad --tier values with usage on stderr and exit 2', async () => {
    const log = output();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--tier'], ['--tier', 'bogus'], ['--tier', 'x', '--tier', 'y'],
      ['--tier', 'fast', '--tier', 'mid'], ['--root', root, '--tier', 'FAST']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(5);
    expect(error.mock.calls[0]?.[0]).toContain('Usage: ashlr fleet work-feed');
  });
});

describe('busWorkFeedJobHold', () => {
  const feedJob = (claimKeys: string[]): BusWorkFeedJob => ({ id: 'J', owner: 'agent:o', to: 'leaders',
    provider: 'devin', repo: 'a/b', title: 'T', claimKeys, status: 'queued', updatedAt: 1,
    postId: 'm-post', statusId: null });

  it('marks provably free, provably held and unknown coverage honestly', () => {
    const held = new Set(['queue:J', 'repo:a/b']);
    // Complete coverage: unheld declared keys are free, held ones are not.
    expect(busWorkFeedJobHold(feedJob(['queue:J', 'path:x']), held, 'complete'))
      .toEqual({ freeKeys: ['path:x'], heldKeys: ['queue:J'], claimable: true });
    expect(busWorkFeedJobHold(feedJob(['queue:J', 'repo:a/b']), held, 'complete'))
      .toEqual({ freeKeys: [], heldKeys: ['queue:J', 'repo:a/b'], claimable: false });
    // Truncated coverage: shown holds are real, but an unshown key might still be held.
    expect(busWorkFeedJobHold(feedJob(['queue:J', 'path:x']), held, 'truncated'))
      .toEqual({ freeKeys: null, heldKeys: ['queue:J'], claimable: null });
    expect(busWorkFeedJobHold(feedJob(['queue:J', 'repo:a/b']), held, 'truncated'))
      .toEqual({ freeKeys: null, heldKeys: ['queue:J', 'repo:a/b'], claimable: false });
    // Unknown coverage: nothing is provable, so nothing is claimed free or held.
    expect(busWorkFeedJobHold(feedJob(['queue:J']), undefined, 'unknown'))
      .toEqual({ freeKeys: null, heldKeys: null, claimable: null });
  });
});
