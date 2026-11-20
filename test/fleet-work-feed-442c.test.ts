import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBusWorkFeed } from '../src/core/agents/bus-work-feed-read.js';
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
