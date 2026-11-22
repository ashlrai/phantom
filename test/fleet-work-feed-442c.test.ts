import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { busWorkFeedJobHold, readBusWorkFeed, type BusWorkFeedJob } from '../src/core/agents/bus-work-feed-read.js';
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

  it('rejects relative roots and invalid flags with usage on stderr and exit 2', async () => {
    const log = output();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', 'relative/path'], ['--status', 'unknown'], ['--root'],
      ['--status', 'queued', '--status', 'done'], ['--json', '--json'], ['--claims', '--claims'], ['--bogus'],
      ['--to'], ['--to', 'two words'], ['--to', 'a\nb'], ['--to', 'x', '--to', 'y']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(11);
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
