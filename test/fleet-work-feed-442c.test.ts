import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBusWorkFeed } from '../src/core/agents/bus-work-feed-read.js';
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

  it('rejects relative roots and invalid flags with usage on stderr and exit 2', async () => {
    const log = output();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--root', 'relative/path'], ['--status', 'unknown'], ['--root'],
      ['--status', 'queued', '--status', 'done'], ['--json', '--json'], ['--claims', '--claims'], ['--bogus']]) {
      expect(await cmdFleetWorkFeed(args)).toBe(2);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(7);
    expect(error.mock.calls[0]?.[0]).toContain('Usage: ashlr fleet work-feed');
    expect(await cmdFleetWorkFeed(['--help'])).toBe(0);
  });
});
