/**
 * Recut of #3154 (desktop slice): GET /api/verse/forum projects the forum
 * store for the desktop Forum pane. The handler runs against a temp forum
 * root; no server, no real home directory.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, writeState } from '../src/core/fleet/forum/store.js';
import type { ForumPost, ForumState } from '../src/core/fleet/forum/types.js';
import { forumRoot } from '../src/core/fleet/forum/view.js';
import { createForumApi, handleForumApi, VERSE_FORUM_PATH as PATH, type ForumApiDeps } from '../src/core/verse/forum-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { narrowForum, overdueCommitments } from '../src/web-ui/routes/verse/fleet-forum/forum-view.js';

const AT = '2026-11-10T12:00:00.000Z';
const live: VerseApiContext = { token: 'fixture-token', allowDispatch: false, readSession: { id: 's1', expiresAt: Date.now() + 60_000 } } as VerseApiContext;

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'recut-70-forum-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

function post(id: string, over: Partial<ForumPost>): ForumPost {
  return {
    id, threadId: 't1', channelId: 'goals', parentId: null, authorId: 'claude', authorKind: 'agent',
    kind: 'note', body: `body ${id}`, payload: { kind: 'note' }, createdAt: AT, clientId: null, mentions: [], wakes: [],
    ...over,
  };
}

async function seed(): Promise<ForumState> {
  const state = emptyState(AT);
  state.threads.push(
    { id: 't1', channelId: 'goals', title: 'Ship the board', createdAt: AT, createdBy: 'claude' },
    { id: 't2', channelId: 'incidents', title: 'Main is red', createdAt: AT, createdBy: 'devin' },
  );
  state.posts.push(
    post('p1', {}),
    post('p2', { body: 'second note', mentions: ['devin'] }),
    post('p3', {
      threadId: 't2', channelId: 'incidents', authorId: 'devin', kind: 'commitment', body: 'I will fix main',
      payload: { kind: 'commitment', owner: 'devin', deadline: '2026-11-09T00:00:00.000Z', summary: 'Fix main', status: 'overdue', jobId: 'RQ-1' },
    }),
  );
  expect(await writeState(root, state)).toEqual({ ok: true });
  return state;
}

async function call(api: ReturnType<typeof createForumApi>, method: string, url: string, ctx: VerseApiContext = live) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await api(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? JSON.parse(payload) as Record<string, any> : null };
}

const api = (deps: ForumApiDeps = {}) => createForumApi({ root, now: () => new Date(AT), ...deps });

describe('GET /api/verse/forum', () => {
  it('projects channels, threads, posts and commitments from the store', async () => {
    await seed();
    const { handled, status, json } = await call(api(), 'GET', PATH);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(json?.v).toBe(1);
    expect(json?.generatedAt).toBe(AT);
    expect(json?.channels.map((c: { id: string }) => c.id)).toEqual(['goals', 'incidents', 'reviews', 'releases', 'growth']);
    expect(json?.channels.find((c: { id: string }) => c.id === 'goals')).toMatchObject({ posts: 2, overdue: 0 });
    expect(json?.channels.find((c: { id: string }) => c.id === 'incidents')).toMatchObject({ posts: 1, overdue: 1 });
    expect(json?.threads).toContainEqual({ id: 't1', channelId: 'goals', title: 'Ship the board', createdAt: AT, posts: 2 });
    expect(json?.posts.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(json?.posts[1]).toMatchObject({ threadTitle: 'Ship the board', mentions: ['devin'] });
    expect(json?.commitments).toEqual([{ id: 'p3', owner: 'devin', deadline: '2026-11-09T00:00:00.000Z', status: 'overdue', summary: 'Fix main', channelId: 'incidents', jobId: 'RQ-1' }]);
  });

  it('filters by channel, thread and limit (latest posts win)', async () => {
    await seed();
    const byChannel = await call(api(), 'GET', `${PATH}?channel=incidents`);
    expect(byChannel.json?.posts.map((p: { id: string }) => p.id)).toEqual(['p3']);
    expect(byChannel.json?.threads.map((t: { id: string }) => t.id)).toEqual(['t2']);
    const byThread = await call(api(), 'GET', `${PATH}?thread=t1&limit=1`);
    expect(byThread.json?.posts.map((p: { id: string }) => p.id)).toEqual(['p2']);
  });

  it('shows the default empty board when nothing was ever written, and never creates the file', async () => {
    const { status, json } = await call(api(), 'GET', PATH);
    expect(status).toBe(200);
    expect(json?.posts).toEqual([]);
    expect(json?.channels).toHaveLength(5);
    const again = await call(api(), 'GET', PATH);
    expect(again.json?.posts).toEqual([]);
  });

  it('feeds the desktop pane: the route shape narrows and overdue commitments surface', async () => {
    await seed();
    const view = narrowForum((await call(api(), 'GET', PATH)).json);
    expect(view).not.toBeNull();
    expect(view?.posts.map((p) => p.body)).toContain('I will fix main');
    expect(overdueCommitments(view!).map((c) => c.id)).toEqual(['p3']);
  });

  it('refuses bad queries with 400 instead of reading as "all"', async () => {
    await seed();
    for (const url of [`${PATH}?channel=nope`, `${PATH}?channel=`, `${PATH}?limit=0`, `${PATH}?limit=101`, `${PATH}?limit=abc`, `${PATH}?root=/tmp`, `${PATH}?channel=goals&channel=incidents`]) {
      const { status, json } = await call(api(), 'GET', url);
      expect(status, url).toBe(400);
      expect(json).toMatchObject({ ok: false });
    }
  });

  it('answers 503 for an unreadable store, never a guessed empty board', async () => {
    await writeFile(join(root, 'forum.json'), '{"v":2}');
    const { status, json } = await call(api(), 'GET', PATH);
    expect(status).toBe(503);
    expect(json).toEqual({ v: 1, ok: false, reason: 'unavailable' });
  });

  it('answers 503 when ASHLR_FORUM_ROOT is relative', async () => {
    const { status } = await call(createForumApi({ env: { ASHLR_FORUM_ROOT: 'relative/forum' } }), 'GET', PATH);
    expect(status).toBe(503);
    expect(() => forumRoot({ ASHLR_FORUM_ROOT: 'relative/forum' })).toThrow('forum-root');
    expect(forumRoot({ ASHLR_HOME: '/scratch/home' })).toBe(join('/scratch/home', 'forum'));
  });

  it('requires a current read session and refuses writes', async () => {
    const noSession = await call(api(), 'GET', PATH, { ...live, readSession: undefined });
    expect(noSession.status).toBe(401);
    const expired = await call(api(), 'GET', PATH, { ...live, readSession: { id: 's1', expiresAt: Date.now() - 1 } });
    expect(expired.status).toBe(401);
    const write = await call(api(), 'POST', PATH);
    expect(write.status).toBe(405);
  });

  it('declines other paths', async () => {
    expect((await call(api(), 'GET', '/api/verse/forumx')).handled).toBe(false);
    expect((await call(api(), 'GET', `${PATH}/posts`)).handled).toBe(false);
  });

  it('the exported handler reads the root from ASHLR_FORUM_ROOT', async () => {
    await seed();
    vi.stubEnv('ASHLR_FORUM_ROOT', root);
    const { status, json } = await call(handleForumApi, 'GET', `${PATH}?channel=goals`);
    expect(status).toBe(200);
    expect(json?.posts.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
  });
});
