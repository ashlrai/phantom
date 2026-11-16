/**
 * Read-only forum projection for the desktop console (GET /api/verse/forum).
 *
 * Recut from #3154's forum service: only the read path lives here, so the
 * console can show the board before the write path (posting, wakes,
 * commitments sweep) lands. Reads never take the forum lock and never write;
 * a forum that was never written projects as the default empty channels.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readState } from './store.js';
import { FORUM_CHANNEL_IDS, type ForumPayload, type ForumReason, type ForumState } from './types.js';

export const FORUM_VIEW_LIMIT_DEFAULT = 50;
export const FORUM_VIEW_LIMIT_MAX = 100;

export interface ForumQuery {
  channelId?: string;
  threadId?: string;
  limit?: number;
}

export interface ForumView {
  v: 1;
  generatedAt: string;
  channels: { id: string; title: string; purpose: string; posts: number; overdue: number }[];
  threads: { id: string; channelId: string; title: string; posts: number; createdAt: string }[];
  posts: {
    id: string; threadId: string; channelId: string; parentId: string | null;
    authorId: string; authorKind: string; kind: string; body: string; createdAt: string;
    threadTitle: string; payload: ForumPayload; mentions: string[];
  }[];
  commitments: { id: string; owner: string; deadline: string; status: string; summary: string; channelId: string; jobId?: string }[];
}

export type ForumViewResult = { ok: true; view: ForumView } | { ok: false; reason: Extract<ForumReason, 'invalid' | 'unavailable'> };

/**
 * ASHLR_FORUM_ROOT (absolute only) overrides `<ASHLR_HOME>/forum`. A relative
 * override throws rather than resolving against whatever cwd the server has.
 */
export function forumRoot(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.ASHLR_FORUM_ROOT;
  if (typeof set === 'string' && set.length > 0) {
    if (!isAbsolute(set)) throw new Error('forum-root');
    return set;
  }
  return join(env.ASHLR_HOME ?? join(homedir(), '.ashlr'), 'forum');
}

export function projectForum(state: ForumState, query: ForumQuery, now: string): ForumView {
  const limit = query.limit ?? FORUM_VIEW_LIMIT_DEFAULT;
  const threads = state.threads.filter((thread) => !query.channelId || thread.channelId === query.channelId);
  const posts = state.posts
    .filter((post) => (!query.channelId || post.channelId === query.channelId) && (!query.threadId || post.threadId === query.threadId))
    .slice(-limit);
  const title = new Map(state.threads.map((thread) => [thread.id, thread.title]));
  const postsPerChannel = new Map<string, number>();
  const overduePerChannel = new Map<string, number>();
  const postsPerThread = new Map<string, number>();
  for (const post of state.posts) {
    postsPerChannel.set(post.channelId, (postsPerChannel.get(post.channelId) ?? 0) + 1);
    postsPerThread.set(post.threadId, (postsPerThread.get(post.threadId) ?? 0) + 1);
    if (post.payload.kind === 'commitment' && post.payload.status === 'overdue') {
      overduePerChannel.set(post.channelId, (overduePerChannel.get(post.channelId) ?? 0) + 1);
    }
  }
  return {
    v: 1,
    generatedAt: now,
    channels: state.channels.map((channel) => ({
      id: channel.id,
      title: channel.title,
      purpose: channel.purpose,
      posts: postsPerChannel.get(channel.id) ?? 0,
      overdue: overduePerChannel.get(channel.id) ?? 0,
    })),
    threads: threads.map((thread) => ({
      id: thread.id, channelId: thread.channelId, title: thread.title, createdAt: thread.createdAt,
      posts: postsPerThread.get(thread.id) ?? 0,
    })),
    posts: posts.map((post) => ({
      id: post.id, threadId: post.threadId, channelId: post.channelId, parentId: post.parentId,
      authorId: post.authorId, authorKind: post.authorKind, kind: post.kind, body: post.body,
      createdAt: post.createdAt, threadTitle: title.get(post.threadId) ?? '', payload: post.payload, mentions: post.mentions,
    })),
    commitments: state.posts.flatMap((post) => post.payload.kind === 'commitment' ? [{
      id: post.id, owner: post.payload.owner, deadline: post.payload.deadline, status: post.payload.status,
      summary: post.payload.summary, channelId: post.channelId, jobId: post.payload.reassignedJobId ?? post.payload.jobId,
    }] : []),
  };
}

export async function readForum(query: ForumQuery, deps: { root: string; now?: () => Date }): Promise<ForumViewResult> {
  if (query.channelId !== undefined && !(FORUM_CHANNEL_IDS as readonly string[]).includes(query.channelId)) return { ok: false, reason: 'invalid' };
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > FORUM_VIEW_LIMIT_MAX)) return { ok: false, reason: 'invalid' };
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const loaded = await readState(deps.root, now);
  if (!loaded.ok) return loaded;
  return { ok: true, view: projectForum(loaded.state, query, now) };
}
