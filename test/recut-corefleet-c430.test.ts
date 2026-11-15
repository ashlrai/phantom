/**
 * Recut C430 (supersedes #5609): the landed forum write path exercised through
 * its real entry points — the shared channel receiver's ingest hook,
 * completeCommitment, and forumTick's once-per-window standup.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import {
  completeCommitment, forumTick, postToForum, readForum, sweepCommitments,
  type ForumDeps, type ForumWakeNotice,
} from '../src/core/fleet/forum/service.js';

const KEY = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const NOW = new Date('2026-11-15T12:00:00.000Z');

let root: string;
let runsDir: string;
const wakes: ForumWakeNotice[] = [];
const dirs: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'recut-c430-forum-'));
  runsDir = await mkdtemp(join(tmpdir(), 'recut-c430-runs-'));
  dirs.push(root, runsDir);
  wakes.length = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const deps = (): ForumDeps => ({
  root,
  now: () => NOW,
  env: { PHANTOM_FORUM_AGENT_KEYS: `codex:${KEY},claude:${OTHER}` },
  signLocally: true,
  runsDir,
  verifyMs: 0,
  sleep: async () => {},
  deliver: async (notice) => { wakes.push(notice); },
});

describe('channel receiver forum ingest (recut c430)', () => {
  it('lands an accepted envelope from the bound owner principal and skips an unbound sender', async () => {
    vi.stubEnv('ASHLR_FORUM_ROOT', root);
    vi.stubEnv('ASHLR_FORUM_INGEST', '1');
    const receive = createChannelReceiver({
      allowedSenderIds: new Set(['mason', 'stranger']),
      runsDir,
    });
    expect((await receive({ channel: 'telegram', verifiedSenderId: 'mason', body: 'from the phone' })).ok).toBe(true);
    expect((await receive({ channel: 'telegram', verifiedSenderId: 'stranger', body: 'not the owner' })).ok).toBe(true);
    // A duplicate receipt is not re-ingested.
    expect((await receive({ channel: 'telegram', verifiedSenderId: 'mason', body: 'dedupe check', requestId: 'dup-1' })).ok).toBe(true);
    expect((await receive({ channel: 'telegram', verifiedSenderId: 'mason', body: 'dedupe check', requestId: 'dup-1' })).ok).toBe(true);

    const view = await readForum({ channelId: 'goals' }, deps());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const bodies = view.view.posts.map((post) => post.body);
    expect(bodies).toEqual(['from the phone', 'dedupe check']);
    expect(view.view.posts[0]?.authorId).toBe('mason');
    expect(view.view.posts[0]?.authorKind).toBe('human');
    expect(view.view.posts[0]?.threadTitle).toBe('From telegram');
  });
});

describe('commitment lifecycle (recut c430)', () => {
  it('sweeps an overdue commitment and settles it through completeCommitment', async () => {
    const created = await postToForum({
      authorId: 'codex',
      authorKind: 'agent',
      channelId: 'goals',
      kind: 'commitment',
      body: 'Own the write path',
      payload: { owner: 'claude', deadline: '2026-11-14T00:00:00.000Z', summary: 'Own the write path' },
    }, deps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const sweep = await sweepCommitments(deps());
    expect(sweep.ok && sweep.flagged).toEqual([created.post.id]);
    expect(sweep.ok && sweep.overdue.length + (sweep.reassigned.length || 0)).toBe(1);

    const done = await completeCommitment(created.post.id, { authorId: 'claude', authorKind: 'agent' }, deps());
    expect(done).toEqual({ ok: true, id: created.post.id, status: 'done' });

    const view = await readForum({ channelId: 'goals' }, deps());
    expect(view.ok && view.view.commitments.find((row) => row.id === created.post.id)?.status).toBe('done');
  });
});

describe('forumTick standup window (recut c430)', () => {
  it('posts the standup once inside ifDueMs and reports the sweep', async () => {
    const first = await forumTick({ merges: 3, mainHealth: 'green', ifDueMs: 60_000 }, deps());
    expect(first.ok && first.standupPosted).toBe(true);
    const second = await forumTick({ merges: 4, mainHealth: 'green', ifDueMs: 60_000 }, deps());
    expect(second.ok && second.standupPosted).toBe(false);

    const view = await readForum({ channelId: 'goals' }, deps());
    expect(view.ok && view.view.posts.filter((post) => post.kind === 'retro')).toHaveLength(1);
  });
});
