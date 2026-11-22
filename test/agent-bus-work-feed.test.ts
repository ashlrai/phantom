import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectBusWorkFeed } from '../src/core/agents/bus-work-feed.js';
import { busWorkFeedRepoKey, busWorkJobDispatch, formatBusWorkFeed, formatBusWorkFeedJob, projectBusWorkFeedView,
  type BusWorkFeedClaims, type BusWorkFeedJob, type BusWorkFeedReadResult } from '../src/core/agents/bus-work-feed-read.js';
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
      repo: 'a/b', title: 'Review', claimKeys: ['repo:a/b'], status: 'terminated', updatedAt: 900 }] },
      citations: new Map([['job', { post: 'm-1', status: 'm-9' }]]) });
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
  it('carries the announcement title and optional dispatch spec onto the job', () => {
    const dispatch = { tier: 'work', scope: 'the scope', acceptance: 'the check' };
    const announced = { ...post, title: 'Fix the feed', dispatch };
    const result = projectBusWorkFeed([receipt(announced)]);
    expect(result).toMatchObject({ status: 'ok', feed: { jobs: [{ id: 'job', title: 'Fix the feed', dispatch }] } });
    if (result.status !== 'ok') throw new Error('fixture refused');
    // The optional spec stays absent, never null, when the post omits it.
    const plain = projectBusWorkFeed([receipt(post)]);
    if (plain.status !== 'ok') throw new Error('fixture refused');
    expect(plain.feed.jobs[0]).not.toHaveProperty('dispatch');
    expect(plain.feed.jobs[0]?.title).toBe('Review');
    expect(workFeedSchema.parse(JSON.parse(JSON.stringify(result.feed)))).toEqual(result.feed);
  });
  it('carries the newest status detail onto the job and clears it when a newer status omits one', () => {
    const status = (cursor: number, body: Record<string, unknown>) =>
      receipt({ kind: 'work.status', jobId: 'job', ...body }, cursor);
    const detailOf = (rows: ReturnType<typeof receipt>[]) => {
      const result = projectBusWorkFeed(rows);
      if (result.status !== 'ok') throw new Error('fixture refused');
      return result.feed.jobs[0]?.detail;
    };
    // A status detail rides the job so a blocked job says why.
    expect(detailOf([receipt(post), status(2, { status: 'blocked', detail: 'waiting on review' })]))
      .toBe('waiting on review');
    // A newer status without detail clears it — never a stale reason on a newer state.
    expect(detailOf([receipt(post), status(2, { status: 'blocked', detail: 'waiting on review' }),
      status(3, { status: 'running' })])).toBeUndefined();
    // The newest detail wins when consecutive statuses both carry one.
    expect(detailOf([receipt(post), status(2, { status: 'blocked', detail: 'old reason' }),
      status(3, { status: 'blocked', detail: 'new reason' })])).toBe('new reason');
    // With no detail ever posted the job keeps no detail key at all.
    const result = projectBusWorkFeed([receipt(post), status(2, { status: 'done' })]);
    if (result.status !== 'ok') throw new Error('fixture refused');
    expect(result.feed.jobs[0]).not.toHaveProperty('detail');
    expect(workFeedSchema.parse(JSON.parse(JSON.stringify(result.feed)))).toEqual(result.feed);
  });
  it('preserves v1 and peer bodies as opaque data and ignores orphan statuses', () => {
    expect(projectBusWorkFeed([
      receipt({ arbitrary: 'legacy' }), receipt('legacy string', 2), receipt({ kind: 'peer.message', peer: {} }, 3),
      receipt({ kind: 'work.status', jobId: 'evicted', status: 'done' }, 4), receipt({ kind: 'note', legacy: true }, 5),
    ])).toEqual({ status: 'ok', feed: { v: 2, jobs: [] }, citations: new Map() });
  });
  it('cites the post and newest accepted status envelopes behind each job', () => {
    const status = (cursor: number, jobId: string, s: string) =>
      receipt({ kind: 'work.status', jobId, status: s }, cursor);
    const result = projectBusWorkFeed([
      status(1, 'job', 'running'),                     // orphan before the post — ignored
      receipt(post, 2),                                 // m-2 announces 'job'
      status(3, 'job', 'blocked'),                      // m-3
      status(4, 'job', 'running'),                      // m-4 — the newest status wins the citation
      receipt({ ...post, jobId: 'other' }, 5, 'agent', 'agent:worker'), // m-5, no status yet
      status(6, 'ghost', 'done'),                       // m-6 — orphan, no job behind it
    ]);
    if (result.status !== 'ok') throw new Error('fixture refused');
    expect(result.citations).toEqual(new Map([
      ['job', { post: 'm-2', status: 'm-4' }],
      ['other', { post: 'm-5', status: null }],
    ]));
  });
  it('cites the newest schema-clean work.result as evidence without moving the job', () => {
    const workResult = (cursor: number, jobId: string, outcome: string,
      extra: Record<string, unknown> = {}, from = 'agent:worker') =>
      receipt({ kind: 'work.result', jobId, claimKey: 'repo:a/b',
        queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome, ...extra }, cursor, from);
    const projected = projectBusWorkFeed([
      workResult(1, 'job', 'complete'),                        // orphan — no job yet
      receipt(post, 2),
      workResult(3, 'job', 'admitted'),
      workResult(4, 'job', 'complete', { reason: 'paths-not-allowed' }),  // newest wins
      workResult(5, 'ghost', 'failed'),                        // orphan — ignored
      receipt({ kind: 'work.result', jobId: 'job', claimKey: 'repo:a/b' }, 6),  // malformed — skipped
      receipt({ kind: 'work.result', jobId: 'job', claimKey: 'repo:a/b',
        queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome: 'failed',
        unexpected: true }, 7),                                 // strict schema — skipped
    ]);
    if (projected.status !== 'ok') throw new Error('fixture refused');
    expect(projected.feed.jobs).toHaveLength(1);
    // The result is evidence only: the job stays queued at the post's receipt
    // time — status, detail and updatedAt all belong to work.status alone.
    expect(projected.feed.jobs[0]).toMatchObject({ id: 'job', status: 'queued', updatedAt: 200 });
    expect(projected.citations.get('job')).toEqual({ post: 'm-2', status: null,
      result: { id: 'm-4', from: 'agent:worker', outcome: 'complete',
        reason: 'paths-not-allowed', receivedAt: 400 } });
  });
  it('keeps the announcer status authoritative when a result lands after it', () => {
    const projected = projectBusWorkFeed([
      receipt(post, 1),
      receipt({ kind: 'work.status', jobId: 'job', status: 'running', detail: 'halfway' }, 2),
      receipt({ kind: 'work.result', jobId: 'job', claimKey: 'repo:a/b',
        queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome: 'complete' }, 3, 'agent:worker'),
    ]);
    if (projected.status !== 'ok') throw new Error('fixture refused');
    expect(projected.feed.jobs[0]).toMatchObject({ status: 'running', detail: 'halfway', updatedAt: 200 });
    expect(projected.citations.get('job')).toEqual({ post: 'm-1', status: 'm-2',
      result: { id: 'm-3', from: 'agent:worker', outcome: 'complete', receivedAt: 300 } });
  });
  it('resolves omitted providers only through explicit participant metadata', () => {
    const { provider: _provider, ...withoutProvider } = post;
    expect(projectBusWorkFeed([receipt(withoutProvider)])).toEqual({ status: 'refused', reason: 'missing-provider',
      receipt: { id: 'm-1', receivedAt: 100, ttl: 1000 } });
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
      .toEqual({ status: 'refused', reason: 'missing-provider',
        receipt: { id: 'm-1', receivedAt: 100, ttl: 1000 } });
    expect(projectBusWorkFeed([receipt(withoutProvider, 1, 'other')], [], () => 'not-a-provider' as never))
      .toEqual({ status: 'refused', reason: 'missing-provider',
        receipt: { id: 'm-1', receivedAt: 100, ttl: 1000 } });
  });
  it.each([
    { ...post, claimKeys: ['path:a/b:../x'] }, { ...post, provider: 'unknown' }, { ...post, extra: true },
    { kind: 'work.status', jobId: 'job', status: 'unknown' },
  ])('refuses malformed v2 work data: %j', body => {
    expect(projectBusWorkFeed([receipt(body)])).toEqual({ status: 'refused', reason: 'invalid-body',
      receipt: { id: 'm-1', receivedAt: 100, ttl: 1000 } });
  });
  it('refuses duplicate posts and status updates from a different routing owner', () => {
    expect(projectBusWorkFeed([receipt(post), receipt(post, 2)])).toEqual({ status: 'refused', reason: 'duplicate-job',
      receipt: { id: 'm-2', receivedAt: 200, ttl: 1000 } });
    expect(projectBusWorkFeed([receipt(post), receipt({ kind: 'work.status', jobId: 'job', status: 'done' }, 2, 'other')]))
      .toEqual({ status: 'refused', reason: 'owner-mismatch',
        receipt: { id: 'm-2', receivedAt: 200, ttl: 1000 } });
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
        .toEqual({ status: 'refused', reason: 'owner-mismatch',
          receipt: { id: 'm-2', receivedAt: 200, ttl: 1000 } });
    }
    // Empty keys never match, and without a resolver labels must be identical.
    expect(projectBusWorkFeed([receipt(post, 1, 'agent:bot'), status(2, 'bot-alias')], [], undefined, () => ''))
      .toEqual({ status: 'refused', reason: 'owner-mismatch',
        receipt: { id: 'm-2', receivedAt: 200, ttl: 1000 } });
    expect(projectBusWorkFeed([receipt(post, 1, 'agent:bot'), status(2, 'bot-alias')]))
      .toEqual({ status: 'refused', reason: 'owner-mismatch',
        receipt: { id: 'm-2', receivedAt: 200, ttl: 1000 } });
  });
  it('names the retained receipt behind each body-level refusal and none for shape refusals', () => {
    const { provider: _provider, ...withoutProvider } = post;
    const cases: Array<[unknown[], string, { id: string; receivedAt: number; ttl: number } | undefined]> = [
      [[receipt(withoutProvider)], 'missing-provider', { id: 'm-1', receivedAt: 100, ttl: 1000 }],
      [[receipt({ ...post, extra: true })], 'invalid-body', { id: 'm-1', receivedAt: 100, ttl: 1000 }],
      [[receipt(post), receipt(post, 2)], 'duplicate-job', { id: 'm-2', receivedAt: 200, ttl: 1000 }],
      [[receipt(post), receipt({ kind: 'work.status', jobId: 'job', status: 'done' }, 2, 'other')],
        'owner-mismatch', { id: 'm-2', receivedAt: 200, ttl: 1000 }],
      // Receipt-shape, participant-metadata and volume refusals blame no single receipt.
      [[null], 'invalid-receipts', undefined],
      [Array(1025).fill(null), 'invalid-receipts', undefined],
      [[], 'invalid-participants', undefined],
    ];
    for (const [rows, reason, receiptSite] of cases) {
      const participants = reason === 'invalid-participants' ? [participant, participant] : [];
      expect(projectBusWorkFeed(rows, participants)).toEqual({ status: 'refused', reason,
        ...(receiptSite === undefined ? {} : { receipt: receiptSite }) });
    }
  });
});

describe('work-feed view filters', () => {
  const viewJob = (over: Partial<BusWorkFeedJob> = {}): BusWorkFeedJob => ({
    id: 'job', owner: 'agent', to: 'leaders', provider: 'devin', repo: 'AshlrAI/Phantom',
    title: 'Review', claimKeys: ['repo:ashlrai/phantom'], status: 'queued', updatedAt: 100,
    postId: 'm-1', statusId: null, ...over,
  });
  const okResult = (jobs: BusWorkFeedJob[], claims?: BusWorkFeedClaims): BusWorkFeedReadResult => ({
    status: 'ok', jobs, receipts: jobs.length, asOf: 'now',
    ...(claims === undefined ? {} : { claims }),
  });
  const ids = (result: BusWorkFeedReadResult) => result.status === 'ok' ? result.jobs.map(job => job.id) : result.status;

  it('normalizes --repo to the lowercase claim-key slug and refuses non-slugs', () => {
    expect(busWorkFeedRepoKey('AshlrAI/Phantom')).toBe('ashlrai/phantom');
    expect(busWorkFeedRepoKey('a/b')).toBe('a/b');
    for (const bad of ['', 'no-slash', 'a/b/c', 'a b/c', 'a//b', '/a', 'a/', 'a\nb/c']) {
      expect(busWorkFeedRepoKey(bad)).toBeUndefined();
    }
  });

  it('keeps jobs by announced repo case-insensitively and by provider', () => {
    const result = okResult([
      viewJob({ id: 'one', repo: 'AshlrAI/Phantom', provider: 'devin' }),
      viewJob({ id: 'two', repo: 'ashlrai/other', provider: 'claude' }),
      viewJob({ id: 'three', repo: 'third/repo', provider: 'devin' }),
    ]);
    expect(ids(projectBusWorkFeedView(result, { repo: 'ashlrai/phantom' }))).toEqual(['one']);
    expect(ids(projectBusWorkFeedView(result, { repo: busWorkFeedRepoKey('ASHLRAI/PHANTOM')! }))).toEqual(['one']);
    expect(ids(projectBusWorkFeedView(result, { repo: 'ashlrai/other' }))).toEqual(['two']);
    expect(ids(projectBusWorkFeedView(result, { repo: 'ghost/repo' }))).toEqual([]);
    expect(ids(projectBusWorkFeedView(result, { provider: 'devin' }))).toEqual(['one', 'three']);
    expect(ids(projectBusWorkFeedView(result, { provider: 'claude' }))).toEqual(['two']);
    // Every dimension narrows: repo and provider compose.
    expect(ids(projectBusWorkFeedView(result, { repo: 'ashlrai/phantom', provider: 'claude' }))).toEqual([]);
    expect(ids(projectBusWorkFeedView(result, { repo: 'ashlrai/phantom', provider: 'devin' }))).toEqual(['one']);
  });

  it('keeps jobs by declared dispatch tier; a job with no spec never matches', () => {
    const result = okResult([
      viewJob({ id: 'fast', dispatch: { tier: 'fast', scope: 's', acceptance: 'a' } }),
      viewJob({ id: 'work', dispatch: { tier: 'work', scope: 's', acceptance: 'a' } }),
      viewJob({ id: 'frontier', dispatch: { tier: 'frontier', scope: 's', acceptance: 'a' } }),
      viewJob({ id: 'plain' }),
    ]);
    expect(ids(projectBusWorkFeedView(result, { tier: 'work' }))).toEqual(['work']);
    expect(ids(projectBusWorkFeedView(result, { tier: 'fast' }))).toEqual(['fast']);
    expect(ids(projectBusWorkFeedView(result, { tier: 'frontier' }))).toEqual(['frontier']);
    // A job carrying no dispatch spec declares no tier and never matches.
    expect(ids(projectBusWorkFeedView(result, { tier: 'mid' }))).toEqual([]);
    // The filter composes with the other structured filters and holds regroup.
    expect(ids(projectBusWorkFeedView(result, { tier: 'work', provider: 'claude' }))).toEqual([]);
    expect(ids(projectBusWorkFeedView(result, { tier: 'work', status: 'queued' }))).toEqual(['work']);
    const claims: BusWorkFeedClaims = { source: 'available', truncated: false, holds: [
      { jobId: 'work', claimKey: 'repo:ashlrai/phantom', owner: 'holder', leaseUntil: 200,
        origin: 'resource', sourceId: 'work:x' },
      { jobId: 'fast', claimKey: 'repo:ashlrai/phantom', owner: 'holder', leaseUntil: 200,
        origin: 'resource', sourceId: 'work:y' },
    ] };
    const view = projectBusWorkFeedView(okResult(result.status === 'ok' ? result.jobs : [], claims), { tier: 'work' });
    expect(ids(view)).toEqual(['work']);
    expect(view.status === 'ok' && view.claims?.holds.map(hold => hold.jobId)).toEqual(['work']);
  });

  it('keeps only provably-claimable open jobs under --claimable and regroups holds', () => {
    const claims: BusWorkFeedClaims = { source: 'available', truncated: false, holds: [
      { jobId: 'held', claimKey: 'repo:ashlrai/phantom', owner: 'holder', leaseUntil: 200,
        origin: 'resource', sourceId: 'work:x' },
    ] };
    const result = okResult([
      viewJob({ id: 'free', claimable: true }),
      viewJob({ id: 'held', claimable: false }),
      viewJob({ id: 'unknown', claimable: null }),
      viewJob({ id: 'done', status: 'done', claimable: undefined }),
    ], claims);
    const view = projectBusWorkFeedView(result, { claimable: true });
    expect(ids(view)).toEqual(['free']);
    // The claims block stays but holds regroup under the shown job only.
    expect(view.status === 'ok' && view.claims?.holds).toEqual([]);
    // Unknown coverage and a read without the claims join never count as claimable.
    expect(ids(projectBusWorkFeedView(okResult([viewJob({ id: 'a', claimable: null })]), { claimable: true }))).toEqual([]);
    expect(ids(projectBusWorkFeedView(okResult([viewJob({ id: 'a' })]), { claimable: true }))).toEqual([]);
  });

  it('keeps jobs whose last activity reaches the --since cutoff and regroups holds', () => {
    const jobs = [
      viewJob({ id: 'old', updatedAt: 100 }),
      viewJob({ id: 'edge', updatedAt: 200 }),
      viewJob({ id: 'new', status: 'done', updatedAt: 300 }),
    ];
    const result = okResult(jobs);
    // Inclusive like every --since bus read: updatedAt == cutoff still shows.
    expect(ids(projectBusWorkFeedView(result, { since: 200 }))).toEqual(['new', 'edge']);
    expect(ids(projectBusWorkFeedView(result, { since: 201 }))).toEqual(['new']);
    expect(ids(projectBusWorkFeedView(result, { since: 400 }))).toEqual([]);
    expect(ids(projectBusWorkFeedView(result, { since: 200, status: 'done' }))).toEqual(['new']);
    // Holds regroup under the jobs still shown: a hidden job's hold never lists.
    const claims: BusWorkFeedClaims = { source: 'available', truncated: false, holds: [
      { jobId: 'old', claimKey: 'repo:ashlrai/phantom', owner: 'holder', leaseUntil: 200,
        origin: 'resource', sourceId: 'work:x' },
      { jobId: 'new', claimKey: 'repo:ashlrai/phantom', owner: 'holder', leaseUntil: 200,
        origin: 'resource', sourceId: 'work:y' },
    ] };
    const view = projectBusWorkFeedView(okResult(jobs, claims), { since: 200 });
    expect(ids(view)).toEqual(['new', 'edge']);
    expect(view.status === 'ok' && view.claims?.holds.map(hold => hold.jobId)).toEqual(['new']);
  });

  it('keeps jobs whose descriptive text carries the --contains needle', () => {
    const dispatch = { tier: 'work' as const, scope: 'Migrate the queue drain path', acceptance: 'Drain finishes green' };
    const jobs = [
      viewJob({ id: 'title', title: 'Fix the Feed drain' }),
      viewJob({ id: 'detail', title: 'Unrelated', detail: 'blocked on mailbox backlog review' }),
      viewJob({ id: 'scope', title: 'Unrelated', dispatch }),
      viewJob({ id: 'accept', title: 'Unrelated', dispatch: { ...dispatch, scope: 'Other scope', acceptance: 'queue DRAIN lands' } }),
      viewJob({ id: 'none', title: 'Polish the docs', repo: 'ashlrai/other', provider: 'claude' }),
    ];
    const result = okResult(jobs);
    // Case-insensitive substring across title, newest status detail and the
    // declared dispatch spec — the fields the job line renders.
    expect(ids(projectBusWorkFeedView(result, { contains: 'feed drain' }))).toEqual(['title']);
    expect(ids(projectBusWorkFeedView(result, { contains: 'MAILBOX BACKLOG' }))).toEqual(['detail']);
    expect(ids(projectBusWorkFeedView(result, { contains: 'queue drain path' }))).toEqual(['scope']);
    expect(ids(projectBusWorkFeedView(result, { contains: 'drain lands' }))).toEqual(['accept']);
    // Whitespace collapses on both sides, so a multi-line needle still finds its job.
    expect(ids(projectBusWorkFeedView(result, { contains: '  queue\n  drain  ' }))).toEqual(['scope', 'accept']);
    // Ids, claim keys, statuses and routing labels are structured fields with
    // their own filters — never search text.
    for (const needle of ['job', 'none', 'queued', 'devin', 'claude', 'ashlrai/phantom',
      'repo:ashlrai/phantom', 'leaders', 'agent', 'm-1']) {
      expect(ids(projectBusWorkFeedView(result, { contains: needle }))).toEqual([]);
    }
    // A blank needle narrows nothing; the needle matches the rendered clip,
    // so text clipped out of the row stays unfindable.
    expect(ids(projectBusWorkFeedView(result, { contains: '   ' }))).toEqual(['title', 'detail', 'scope', 'accept', 'none']);
    const clipped = okResult([viewJob({ id: 'long', title: `${'x'.repeat(200)}needle-tail` })]);
    expect(ids(projectBusWorkFeedView(clipped, { contains: 'needle-tail' }))).toEqual([]);
    // Matching runs over the scrubbed display text: a secret-shaped value is
    // unfindable even though the stored job keeps it.
    const secret = okResult([viewJob({ id: 'secret', title: `rotate sk-${'a'.repeat(24)} now` })]);
    expect(ids(projectBusWorkFeedView(secret, { contains: 'sk-aaaaaaaa' }))).toEqual([]);
    expect(ids(projectBusWorkFeedView(secret, { contains: 'rotate' }))).toEqual(['secret']);
    // The filter composes with the others and holds still regroup under shown jobs.
    const claims: BusWorkFeedClaims = { source: 'available', truncated: false, holds: [
      { jobId: 'title', claimKey: 'repo:ashlrai/phantom', owner: 'holder', leaseUntil: 200,
        origin: 'resource', sourceId: 'work:x' },
      { jobId: 'none', claimKey: 'repo:ashlrai/phantom', owner: 'holder', leaseUntil: 200,
        origin: 'resource', sourceId: 'work:y' },
    ] };
    const view = projectBusWorkFeedView(okResult(jobs, claims), { contains: 'drain', status: 'queued' });
    expect(ids(view)).toEqual(['title', 'scope', 'accept']);
    expect(view.status === 'ok' && view.claims?.holds.map(hold => hold.jobId)).toEqual(['title']);
  });

  it('passes non-ok reads through untouched', () => {
    const refused: BusWorkFeedReadResult = { status: 'refused', reason: 'duplicate-job', receipts: 2, asOf: 'now' };
    expect(projectBusWorkFeedView(refused, { repo: 'a/b', provider: 'devin', claimable: true, since: 1, contains: 'x' })).toBe(refused);
  });
});

describe('work-feed job line rendering', () => {
  const feedJob = (over: Partial<BusWorkFeedJob> = {}): BusWorkFeedJob => ({
    id: 'job', owner: 'agent', to: 'leaders', provider: 'devin', repo: 'a/b',
    title: 'Review', claimKeys: ['repo:a/b'], status: 'queued', updatedAt: 100,
    postId: 'm-1', statusId: null, ...over,
  });

  it('renders the declared dispatch spec on the job line and feed', () => {
    const job = feedJob({ dispatch: { tier: 'work', scope: 'the scope', acceptance: 'the check' } });
    expect(formatBusWorkFeedJob(job))
      .toContain('repo=a/b tier=work scope="the scope" acceptance="the check" keys=repo:a/b');
    expect(formatBusWorkFeed({ status: 'ok', jobs: [job], receipts: 1, asOf: 'now' }).join('\n'))
      .toContain('tier=work scope="the scope" acceptance="the check"');
  });

  it('omits every dispatch field when the post carried no spec', () => {
    const line = formatBusWorkFeedJob(feedJob());
    expect(line).not.toContain('tier=');
    expect(line).not.toContain('scope=');
    expect(line).not.toContain('acceptance=');
    expect(busWorkJobDispatch(undefined)).toBe('');
  });

  it('renders the newest work.result report on the job line and feed', () => {
    const job = feedJob({ status: 'running',
      result: { id: 'm-9', from: 'agent:worker', outcome: 'complete',
        reason: 'paths-not-allowed', receivedAt: 100 } });
    expect(formatBusWorkFeedJob(job)).toContain(
      'result=complete reason=paths-not-allowed by=agent:worker at=1970-01-01T00:00:00.100Z receipt=m-9');
    expect(formatBusWorkFeed({ status: 'ok', jobs: [job], receipts: 1, asOf: 'now' }).join('\n'))
      .toContain('receipt=m-9');
    // No retained result: the suffix stays absent entirely, never a placeholder.
    expect(formatBusWorkFeedJob(feedJob())).not.toContain('result=');
  });

  it('clips and single-lines dispatch text like every other feed field', () => {
    const tag = busWorkJobDispatch({ tier: 'fast', scope: `start ${'x'.repeat(300)}`, acceptance: 'one\ntwo' });
    expect(tag).toContain('tier=fast');
    const scope = tag.match(/scope="([^"]*)"/)?.[1] ?? '';
    expect(scope).toHaveLength(200);
    expect(scope.endsWith('…')).toBe(true);
    expect(tag).toContain('acceptance="one two"');
  });
});
