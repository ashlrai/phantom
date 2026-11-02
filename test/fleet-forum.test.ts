/**
 * Forum auth, human invites, rate and loop limits, channel ingest, CLI, and HTTP.
 * Bodies that look like shell stay stored text.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdForum } from '../src/cli/forum.js';
import { canonicalPost, signPost } from '../src/core/fleet/forum/canon.js';
import { deliverMirror } from '../src/core/fleet/forum/bridge.js';
import {
  bindPrincipal, ensureForum, inviteHuman, postToForum, readForum, setBridge,
  type ForumDeps, type ForumWakeNotice,
} from '../src/core/fleet/forum/service.js';
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import { createForumApi } from '../src/core/verse/forum-api.js';

const KEY = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
let root: string;
let env: NodeJS.ProcessEnv;
const wakes: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-forum-unit-'));
  env = {
    PHANTOM_FORUM_AGENT_KEYS: `codex:${KEY},claude:${OTHER}`,
    PHANTOM_FORUM_MASON_PROOF: 'mason-proof-value',
    PHANTOM_FORUM_HUMAN_PROOFS: 'ada:ada-proof-value-ok',
  };
  wakes.length = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function deps(now = new Date('2026-11-02T00:00:00.000Z')): ForumDeps {
  return {
    root, env, now: () => now, signLocally: true,
    deliver: async (notice: ForumWakeNotice) => { wakes.push(`${notice.target}:${notice.excerpt}`); },
    mirror: async () => 'sent',
  };
}

describe('identity and safety', () => {
  it('rejects an unknown agent, a bad signature, and a human who was not invited', async () => {
    const missing = await postToForum({ authorId: 'grok', authorKind: 'agent', channelId: 'goals', kind: 'note', body: 'hello' }, { ...deps(), signLocally: false });
    expect(missing).toEqual({ ok: false, reason: 'unknown-agent' });
    const canon = canonicalPost({ authorId: 'codex', channelId: 'goals', threadId: '-', parentId: '-', kind: 'note', body: 'hello', clientId: '-', payload: {} });
    const bad = await postToForum({
      authorId: 'codex', authorKind: 'agent', channelId: 'goals', kind: 'note', body: 'hello', signature: 'ab'.repeat(32),
    }, { ...deps(), signLocally: false });
    expect(bad).toEqual({ ok: false, reason: 'bad-signature' });
    const signed = await postToForum({
      authorId: 'codex', authorKind: 'agent', channelId: 'goals', kind: 'note', body: 'hello', signature: signPost(KEY, canon),
    }, { ...deps(), signLocally: false });
    expect(signed.ok).toBe(true);
    const stranger = await postToForum({ authorId: 'ada', authorKind: 'human', channelId: 'goals', kind: 'note', body: 'I am not invited' }, deps());
    expect(stranger).toEqual({ ok: false, reason: 'human-unauthorized' });
    expect(await inviteHuman('ada', deps())).toMatchObject({ ok: true, humanId: 'ada' });
    const invited = await postToForum({ authorId: 'ada', authorKind: 'human', channelId: 'reviews', kind: 'review-request', body: 'Please look', payload: { subject: 'forum', reviewer: 'codex' } }, deps());
    expect(invited.ok).toBe(true);
    expect(wakes.some((wake) => wake.startsWith('codex:'))).toBe(true);
  });

  it('stores shell-shaped text and refuses secret-shaped text', async () => {
    const posted = await postToForum({ authorId: 'codex', authorKind: 'agent', channelId: 'goals', kind: 'note', body: 'status; rm -rf /tmp/nope && echo $(whoami)' }, deps());
    expect(posted.ok && posted.post.body).toBe('status; rm -rf /tmp/nope && echo $(whoami)');
    const secret = await postToForum({ authorId: 'codex', authorKind: 'agent', channelId: 'goals', kind: 'note', body: 'token sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, deps());
    expect(secret.ok).toBe(false);
  });

  it('stops a mention loop and a post flood', async () => {
    const say = (author: 'codex' | 'claude', body: string, minute: number) => postToForum({
      authorId: author, authorKind: 'agent', channelId: 'goals', kind: 'note', body,
    }, deps(new Date(Date.parse('2026-11-02T00:00:00.000Z') + minute * 1000)));
    const first = await say('codex', '@claude ping', 1);
    expect(first.ok && first.post.wakes).toEqual([{ target: 'claude', status: 'sent' }]);
    expect((await say('claude', '@codex pong', 2)).ok && true).toBe(true);
    expect((await say('codex', '@claude ping', 3)).ok && true).toBe(true);
    expect((await say('claude', '@codex pong', 4)).ok && true).toBe(true);
    const suppressed = await say('codex', '@claude enough', 5);
    expect(suppressed.ok && suppressed.post.wakes).toEqual([{ target: 'claude', status: 'suppressed-loop' }]);
    for (let index = 0; index < 12; index += 1) {
      const result = await postToForum({ authorId: 'codex', authorKind: 'agent', channelId: 'growth', kind: 'note', body: `note ${index}` }, deps(new Date(Date.parse('2026-11-02T01:00:00.000Z') + index * 1000)));
      expect(result.ok).toBe(true);
    }
    const flood = await postToForum({ authorId: 'codex', authorKind: 'agent', channelId: 'growth', kind: 'note', body: 'one more' }, deps(new Date('2026-11-02T01:00:20.000Z')));
    expect(flood).toEqual({ ok: false, reason: 'rate-limited' });
  });
});

describe('channels, CLI, and HTTP', () => {
  it('copies a bound channel sender into #goals and ignores everyone else', async () => {
    process.env.ASHLR_FORUM_ROOT = root;
    process.env.PHANTOM_FORUM_MASON_PROOF = 'mason-proof-value';
    try {
      await ensureForum(deps());
      expect(await bindPrincipal('telegram:42', 'mason', deps())).toMatchObject({ ok: true });
      const receive = createChannelReceiver({ allowedSenderIds: new Set(['telegram:42', 'telegram:99']), runsDir: join(root, 'runs'), busRoot: join(root, 'bus') });
      expect((await receive({ channel: 'telegram', verifiedSenderId: 'telegram:42', body: 'ship the forum' })).ok).toBe(true);
      expect((await receive({ channel: 'telegram', verifiedSenderId: 'telegram:99', body: 'not mason' })).ok).toBe(true);
      const view = await readForum({ channelId: 'goals' }, deps());
      expect(view.ok && view.view.posts.map((post) => post.body)).toEqual(['ship the forum']);
    } finally {
      delete process.env.ASHLR_FORUM_ROOT;
      delete process.env.PHANTOM_FORUM_MASON_PROOF;
    }
  });

  it('posts and reads through the CLI', async () => {
    const lines: string[] = [];
    const code = await cmdForum(['post', '--channel', 'releases', '--author', 'codex', '--kind', 'note', '--body', 'cutting a release', '--json', '--root', root], { stdout: (line) => lines.push(line), env });
    expect(code).toBe(0);
    const read: string[] = [];
    expect(await cmdForum(['read', '--channel', 'releases', '--root', root], { stdout: (line) => read.push(line), env })).toBe(0);
    expect(read.join('')).toContain('cutting a release');
    expect(await cmdForum(['--help'], { stdout: () => {}, env })).toBe(0);
  });

  it('serves a read session and refuses a post over HTTP', async () => {
    await postToForum({ authorId: 'codex', authorKind: 'agent', channelId: 'growth', kind: 'note', body: 'stars moved' }, deps());
    const api = createForumApi({ root, now: () => new Date('2026-11-02T00:00:00.000Z'), env });
    const call = async (method: string, session: boolean) => {
      let status = 0; let body = '';
      const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(payload?: string) { body = payload ?? ''; }, setHeader() {} };
      const req = { url: '/api/verse/forum?channel=growth', headers: {} } as IncomingMessage;
      const ctx = { readSession: session ? { id: 's', expiresAt: Date.now() + 60_000 } : undefined, allowDispatch: false, token: 'x'.repeat(64), cfg: {} };
      await api(ctx as never, req, res as unknown as ServerResponse, '/api/verse/forum', method);
      return { status, body: body ? JSON.parse(body) as { posts?: { body: string }[] } : null };
    };
    expect((await call('GET', false)).status).toBe(401);
    const ok = await call('GET', true);
    expect(ok.status).toBe(200);
    expect(ok.body?.posts?.[0]?.body).toBe('stars moved');
    expect((await call('POST', true)).status).toBe(405);
  });

  it('mirrors an enabled channel through the discord adapter and skips a non-webhook URL', async () => {
    expect(await deliverMirror('discord', 'hello', { PHANTOM_FORUM_DISCORD_WEBHOOK: 'file:///tmp/hook' })).toBe('skipped');
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return new Response(null, { status: 204 });
    }));
    try {
      expect(await deliverMirror('discord', '#goals · codex · note\nhello', { PHANTOM_FORUM_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/123456789/abcdefghij' })).toBe('sent');
      expect(calls).toEqual(['{"content":"#goals · codex · note\\nhello"}']);
    } finally { vi.unstubAllGlobals(); }
    expect(await setBridge('goals', 'telegram', true, deps())).toMatchObject({ ok: true, enabled: true });
    const posted = await postToForum({ authorId: 'codex', authorKind: 'agent', channelId: 'goals', kind: 'note', body: 'mirrored' }, deps());
    expect(posted.ok && posted.mirror).toBe('sent');
    expect(existsSync(join(root, 'forum.json'))).toBe(true);
  });
});
