import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectBusWorkFeed } from '../src/core/agents/bus-work-feed.js';
import { workFeedSchema, type Participant, WORK_STATUSES } from '../src/core/agents/bus-v2-schema.js';
import { isClaimableWork } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const post = { kind: 'work.post', jobId: 'job', title: 'Review', repo: 'a/b', claimKeys: ['repo:a/b'], provider: 'devin' };
const receipt = (body: unknown, cursor = 1, from = 'agent', to = 'leaders') => ({ cursor, receivedAt: cursor * 100,
  envelope: { id: `m-${cursor}`, from, to, priority: 'P2', ttl: 1000, body } });
const participant: Participant = { participantId: 'agent', provider: 'claude', displayName: 'Agent',
  capabilities: [], wake: { kind: 'poll', target: 'agent' }, status: 'active' };

describe('retained v2 work projection', () => {
  it('reads a v1 journal and preserves legacy records across a versioned append', () => {
    const root = mkdtempSync(join(tmpdir(), 'bus-v2-legacy-'));
    try {
      mkdirSync(join(root, 'bus-inbox'), { mode: 0o700 });
      const file = join(root, 'bus-inbox', 'messages.json');
      const legacy = receipt({ note: 'legacy' });
      writeFileSync(file, JSON.stringify([legacy]), { mode: 0o600 });
      expect(listBusInboxAfter(0, 100, { root, now: () => 100 })).toMatchObject({ status: 'ok', messages: [legacy] });
      expect(appendBusInbox(receipt(post, 2).envelope, { root, now: () => 200 }).status).toBe('posted');
      const page = listBusInboxAfter(0, 100, { root, now: () => 200 });
      if (page.status !== 'ok') throw new Error('fixture unavailable');
      expect(page.messages[0]?.envelope.body).toEqual(legacy.envelope.body);
      expect(projectBusWorkFeed(page.messages)).toMatchObject({ status: 'ok', feed: { v: 2, jobs: [{ id: 'job' }] } });
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('writes a versioned feed and applies every status in cursor order', () => {
    const rows = [receipt(post), ...WORK_STATUSES.map((status, n) => receipt({ kind: 'work.status', jobId: 'job', status }, n + 2))];
    const result = projectBusWorkFeed(rows);
    expect(result).toEqual({ status: 'ok', feed: { v: 2, jobs: [{ id: 'job', owner: 'agent', to: 'leaders', provider: 'devin',
      repo: 'a/b', claimKeys: ['repo:a/b'], status: 'terminated', updatedAt: 900 }] } });
    if (result.status !== 'ok') throw new Error('fixture refused');
    expect(workFeedSchema.parse(JSON.parse(JSON.stringify(result.feed)))).toEqual(result.feed);
    expect(rows[0]!.envelope.body).toEqual(post);
    expect(isClaimableWork(post)).toBe(false);
  });
  it('keeps the post announcement address on the job across status updates', () => {
    const directed = receipt(post, 1, 'agent', 'agent:worker');
    const rows = [directed, receipt({ kind: 'work.status', jobId: 'job', status: 'running' }, 2, 'agent', 'leaders')];
    expect(projectBusWorkFeed(rows)).toMatchObject({ status: 'ok',
      feed: { jobs: [{ id: 'job', owner: 'agent', to: 'agent:worker', status: 'running' }] } });
  });
  it('preserves v1 and peer bodies as opaque data and ignores orphan statuses', () => {
    expect(projectBusWorkFeed([
      receipt({ arbitrary: 'legacy' }), receipt('legacy string', 2), receipt({ kind: 'peer.message', peer: {} }, 3),
      receipt({ kind: 'work.status', jobId: 'evicted', status: 'done' }, 4), receipt({ kind: 'note', legacy: true }, 5),
    ])).toEqual({ status: 'ok', feed: { v: 2, jobs: [] } });
  });
  it('resolves omitted providers only through explicit participant metadata', () => {
    const { provider: _provider, ...withoutProvider } = post;
    expect(projectBusWorkFeed([receipt(withoutProvider)])).toEqual({ status: 'refused', reason: 'missing-provider' });
    const result = projectBusWorkFeed([receipt(withoutProvider)], [participant]);
    expect(result.status === 'ok' && result.feed.jobs[0]?.provider).toBe('claude');
    expect(projectBusWorkFeed([], [participant, participant])).toEqual({ status: 'refused', reason: 'invalid-participants' });
  });
  it('consults the provider resolver only after the post and participant metadata', () => {
    const { provider: _provider, ...withoutProvider } = post;
    const byLabel = (from: string) => (from === 'other' ? 'glm' : undefined);
    // Participant metadata still wins over the resolver.
    expect(projectBusWorkFeed([receipt(withoutProvider)], [participant], byLabel))
      .toMatchObject({ status: 'ok', feed: { jobs: [{ provider: 'claude' }] } });
    // The resolver supplies a provider the post and participants lack.
    expect(projectBusWorkFeed([receipt(withoutProvider, 1, 'other')], [], byLabel))
      .toMatchObject({ status: 'ok', feed: { jobs: [{ provider: 'glm' }] } });
    // An explicit post provider wins over both.
    expect(projectBusWorkFeed([receipt(post, 1, 'other')], [participant], byLabel))
      .toMatchObject({ status: 'ok', feed: { jobs: [{ provider: 'devin' }] } });
    // Unknown and invalid hints still refuse rather than guessing.
    expect(projectBusWorkFeed([receipt(withoutProvider, 1, 'other')], [], () => undefined))
      .toEqual({ status: 'refused', reason: 'missing-provider' });
    expect(projectBusWorkFeed([receipt(withoutProvider, 1, 'other')], [], () => 'not-a-provider' as never))
      .toEqual({ status: 'refused', reason: 'missing-provider' });
  });
  it.each([
    { ...post, claimKeys: ['path:a/b:../x'] }, { ...post, provider: 'unknown' }, { ...post, extra: true },
    { kind: 'work.status', jobId: 'job', status: 'unknown' },
  ])('refuses malformed v2 work data: %j', body => {
    expect(projectBusWorkFeed([receipt(body)])).toEqual({ status: 'refused', reason: 'invalid-body' });
  });
  it('refuses duplicate posts and status updates from a different routing owner', () => {
    expect(projectBusWorkFeed([receipt(post), receipt(post, 2)])).toEqual({ status: 'refused', reason: 'duplicate-job' });
    expect(projectBusWorkFeed([receipt(post), receipt({ kind: 'work.status', jobId: 'job', status: 'done' }, 2, 'other')]))
      .toEqual({ status: 'refused', reason: 'owner-mismatch' });
  });
  it.each([
    [null], [receipt(post), receipt(post)], [{ ...receipt(post), receivedAt: -1 }],
    [{ ...receipt(post), cursor: 1.5 }], [receipt({ bad: Number.NaN })], Array(1025).fill(null),
  ])('refuses invalid receipt snapshots', (...rows) => {
    expect(projectBusWorkFeed(rows)).toEqual({ status: 'refused', reason: 'invalid-receipts' });
  });
  it('uses cursor order for sparse retained rows even with reversed receipt clocks', () => {
    expect(projectBusWorkFeed([receipt(post), { ...receipt({ kind: 'work.status', jobId: 'job', status: 'done' }, 10), receivedAt: 1 }]))
      .toMatchObject({ status: 'ok', feed: { jobs: [{ status: 'done', updatedAt: 1 }] } });
  });
  it('matches status owners through ownerKeyFor only when both labels resolve to one key', () => {
    const keys: Record<string, string> = { 'agent:bot': 'agt_one', 'bot-alias': 'agt_one', 'agent:other': 'agt_two' };
    const ownerKeyFor = (from: string) => keys[from];
    const status = (cursor: number, from: string) => receipt({ kind: 'work.status', jobId: 'job', status: 'running' }, cursor, from);
    // Sibling labels of one identity update the job; owner stays the posting label.
    expect(projectBusWorkFeed([receipt(post, 1, 'agent:bot'), status(2, 'bot-alias')], [], undefined, ownerKeyFor))
      .toMatchObject({ status: 'ok', feed: { jobs: [{ owner: 'agent:bot', status: 'running' }] } });
    // Different identities, and labels the resolver cannot place, still refuse.
    for (const from of ['agent:other', 'stranger']) {
      expect(projectBusWorkFeed([receipt(post, 1, 'agent:bot'), status(2, from)], [], undefined, ownerKeyFor))
        .toEqual({ status: 'refused', reason: 'owner-mismatch' });
    }
    // Empty keys never match, and without a resolver labels must be identical.
    expect(projectBusWorkFeed([receipt(post, 1, 'agent:bot'), status(2, 'bot-alias')], [], undefined, () => ''))
      .toEqual({ status: 'refused', reason: 'owner-mismatch' });
    expect(projectBusWorkFeed([receipt(post, 1, 'agent:bot'), status(2, 'bot-alias')]))
      .toEqual({ status: 'refused', reason: 'owner-mismatch' });
  });
});
