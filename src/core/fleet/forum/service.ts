/**
 * Fleet forum: threads, authenticated posts, mentions, commitments, and
 * standups. Bodies stay data. Wakes are bus envelopes, not shell commands.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { appendBusInbox } from '../bus-inbox.js';
import { writeDropJob, type DropJobInput, type DropJobWritten } from '../drop-job-writer.js';
import { ReassignError, reassignQueuedJobs, type ReassignInput, type ReassignReportV1 } from '../runs-reassign.js';
import { deliverMirror, mirrorText } from './bridge.js';
import {
  canonicalPost, checkBody, excerpt, isAgentId, isChannelId, isKind, isPrincipal,
  parseMentions, parsePayload, sameSecret, signable, stableJson, structuredTargets, verifyPost, CLIENT_ID,
} from './canon.js';
import { resolveAgentKey, type KeychainExec } from './keys.js';
import { planWakes, prune } from './policy.js';
import { readState, withForumLock, writeState } from './store.js';
import {
  FORUM_OWNER, FORUM_POST_MAX, FORUM_STEWARD, FORUM_THREAD_MAX,
  type ForumChannelId, type ForumKind, type ForumPayload, type ForumPost, type ForumReason,
  type ForumState, type ForumThread, type ForumWakeNotice, type NorthStar,
} from './types.js';

export interface ForumDeps {
  root: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  signLocally?: boolean;
  deliver?: (notice: ForumWakeNotice) => Promise<void>;
  mirror?: (adapter: 'telegram' | 'discord', text: string) => Promise<'sent' | 'skipped' | 'failed'>;
  reassign?: (input: ReassignInput, opts: { runsDir?: string; now?: () => Date; verifyMs?: number; sleep?: (ms: number) => Promise<void>; changedBy?: string }) => Promise<ReassignReportV1>;
  dropJob?: (root: string, input: DropJobInput, now?: () => Date) => Promise<DropJobWritten>;
  runsDir?: string;
  verifyMs?: number;
  sleep?: (ms: number) => Promise<void>;
  keychain?: KeychainExec;
}

export interface ForumPostRequest {
  authorId: string;
  authorKind: 'agent' | 'human';
  channelId: string;
  threadId?: string;
  parentId?: string;
  title?: string;
  kind: string;
  body: string;
  payload?: unknown;
  clientId?: string;
  signature?: string;
  /** Set only by the channel receiver after it has authenticated the sender. */
  trustedPrincipal?: string;
}

export type ForumResult<T> = { ok: true } & T | { ok: false; reason: ForumReason };

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

interface Draft {
  authorId: string;
  authorKind: ForumPost['authorKind'];
  channelId: ForumChannelId;
  threadId?: string;
  parentId?: string;
  title?: string;
  kind: ForumKind;
  body: string;
  payload: ForumPayload;
  clientId?: string;
  exemptPostRate?: boolean;
}

function clock(deps: ForumDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function environment(deps: ForumDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

export function forumRoot(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.ASHLR_FORUM_ROOT;
  if (typeof set === 'string' && set.length > 0) {
    if (!isAbsolute(set)) throw new Error('forum-root');
    return set;
  }
  return join(env.ASHLR_HOME ?? join(homedir(), '.ashlr'), 'forum');
}

export function forumIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ASHLR_FORUM_INGEST === '0') return false;
  if (env.ASHLR_FORUM_INGEST === '1') return true;
  try { return existsSync(join(forumRoot(env), 'forum.json')); } catch { return false; }
}

function humanProof(env: NodeJS.ProcessEnv, id: string): string | null {
  if (id === FORUM_OWNER) {
    const value = env.PHANTOM_FORUM_MASON_PROOF;
    return typeof value === 'string' && value.length >= 16 && !/\s/.test(value) ? value : null;
  }
  const raw = env.PHANTOM_FORUM_HUMAN_PROOFS;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(',')) {
    const index = part.indexOf(':');
    if (index < 1) continue;
    const name = part.slice(0, index);
    const proof = part.slice(index + 1);
    if (name === id && proof.length >= 16 && !/\s/.test(proof)) return proof;
  }
  return null;
}

function humanAllowed(state: ForumState, id: string): boolean {
  return id === FORUM_OWNER || state.invites.some((invite) => invite.humanId === id);
}

function humanForPrincipal(state: ForumState, principal: string): string | null {
  const row = state.principals.find((item) => item.principal === principal);
  return row && humanAllowed(state, row.humanId) ? row.humanId : null;
}

async function defaultDeliver(notice: ForumWakeNotice): Promise<void> {
  const result = appendBusInbox({
    id: `fw-${notice.postId}-${notice.target}`.slice(0, 128),
    from: 'forum',
    to: notice.target,
    priority: 'P2',
    ttl: 600_000,
    body: {
      type: 'forum.mention',
      channelId: notice.channelId,
      threadId: notice.threadId,
      postId: notice.postId,
      excerpt: notice.excerpt,
    },
  });
  if (result.status !== 'posted' && result.status !== 'duplicate') throw new Error('wake-failed');
}

function project(state: ForumState, query: { channelId?: string; threadId?: string; limit?: number }, now: string): ForumView {
  const limit = query.limit ?? 50;
  const threads = state.threads.filter((thread) => !query.channelId || thread.channelId === query.channelId);
  const posts = state.posts
    .filter((post) => (!query.channelId || post.channelId === query.channelId) && (!query.threadId || post.threadId === query.threadId))
    .slice(-limit);
  const title = new Map(state.threads.map((thread) => [thread.id, thread.title]));
  return {
    v: 1,
    generatedAt: now,
    channels: state.channels.map((channel) => ({
      id: channel.id,
      title: channel.title,
      purpose: channel.purpose,
      posts: state.posts.filter((post) => post.channelId === channel.id).length,
      overdue: state.posts.filter((post) => post.channelId === channel.id && post.payload.kind === 'commitment' && post.payload.status === 'overdue').length,
    })),
    threads: threads.map((thread) => ({
      id: thread.id, channelId: thread.channelId, title: thread.title, createdAt: thread.createdAt,
      posts: state.posts.filter((post) => post.threadId === thread.id).length,
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

function commitPost(state: ForumState, draft: Draft, now: Date): ForumResult<{ post: ForumPost; thread: ForumThread; notices: ForumWakeNotice[]; duplicate?: boolean }> {
  const nowMs = now.getTime();
  const iso = now.toISOString();
  if (draft.clientId) {
    const prior = state.posts.find((post) => post.authorId === draft.authorId && post.clientId === draft.clientId);
    if (prior) {
      const same = prior.body === draft.body && prior.kind === draft.kind && stableJson(signable(prior.payload)) === stableJson(signable(draft.payload));
      const thread = state.threads.find((item) => item.id === prior.threadId);
      if (!same || !thread) return { ok: false, reason: 'conflict' };
      return { ok: true, post: prior, thread, notices: [], duplicate: true };
    }
  }
  let thread = draft.threadId ? state.threads.find((item) => item.id === draft.threadId) : undefined;
  if (draft.threadId && (!thread || thread.channelId !== draft.channelId)) return { ok: false, reason: 'unknown-thread' };
  if (draft.parentId) {
    const parent = state.posts.find((post) => post.id === draft.parentId);
    if (!parent || !thread || parent.threadId !== thread.id) return { ok: false, reason: 'unknown-parent' };
  }
  const targets = [...new Set([...parseMentions(draft.body), ...structuredTargets(draft.payload)])];
  if (targets.length > 8 || targets.some((target) => !isAgentId(target) && target !== FORUM_STEWARD)) return { ok: false, reason: 'invalid' };
  const planned = planWakes(state, draft.authorId, targets, nowMs, draft.exemptPostRate === true);
  if (!planned.ok) return planned;
  if (!thread) {
    if (state.threads.length >= FORUM_THREAD_MAX) return { ok: false, reason: 'full' };
    const title = (draft.title ?? draft.body.split('\n')[0] ?? 'thread').slice(0, 80);
    thread = { id: `t${randomBytes(8).toString('hex')}`, channelId: draft.channelId, title, createdAt: iso, createdBy: draft.authorId };
    state.threads.push(thread);
  }
  if (state.posts.length >= FORUM_POST_MAX) return { ok: false, reason: 'full' };
  const post: ForumPost = {
    id: `p${randomBytes(8).toString('hex')}`,
    threadId: thread.id,
    channelId: draft.channelId,
    parentId: draft.parentId ?? null,
    authorId: draft.authorId,
    authorKind: draft.authorKind,
    kind: draft.kind,
    body: draft.body,
    payload: draft.payload,
    createdAt: iso,
    clientId: draft.clientId ?? null,
    mentions: targets,
    wakes: planned.plans.map((plan) => ({ target: plan.target, status: plan.status })),
  };
  state.posts.push(post);
  if (draft.authorKind !== 'system') state.postTimes.push({ author: draft.authorId, at: nowMs });
  for (const plan of planned.plans) state.wakes.push({ from: draft.authorId, to: plan.target, at: nowMs, status: plan.status });
  prune(state, nowMs);
  const notices = planned.plans.filter((plan) => plan.status === 'sent').map((plan) => ({
    target: plan.target, postId: post.id, channelId: post.channelId, threadId: post.threadId, excerpt: excerpt(post.body),
  }));
  return { ok: true, post, thread, notices };
}

async function finish(deps: ForumDeps, state: ForumState, post: ForumPost, notices: ForumWakeNotice[]): Promise<'sent' | 'skipped' | 'failed' | 'none'> {
  const deliver = deps.deliver ?? defaultDeliver;
  let dirty = false;
  for (const notice of notices) {
    try { await deliver(notice); } catch {
      const wake = post.wakes.find((item) => item.target === notice.target);
      if (wake) wake.status = 'failed';
      const logged = [...state.wakes].reverse().find((item) => item.from === post.authorId && item.to === notice.target && item.status === 'sent');
      if (logged) logged.status = 'failed';
      dirty = true;
    }
  }
  if (dirty) await writeState(deps.root, state);
  const bridges = state.bridges.filter((bridge) => bridge.enabled && bridge.channelId === post.channelId);
  if (bridges.length === 0) return 'none';
  const text = mirrorText(state.channels.find((channel) => channel.id === post.channelId)?.title ?? post.channelId, post);
  const mirror = deps.mirror ?? ((adapter: 'telegram' | 'discord', value: string) => deliverMirror(adapter, value, environment(deps)));
  const statuses = [];
  for (const bridge of bridges) statuses.push(await mirror(bridge.adapter, text));
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('sent')) return 'sent';
  return 'skipped';
}

async function mutate<T extends { ok: boolean }>(deps: ForumDeps, fn: (state: ForumState, now: Date) => Promise<T>): Promise<T | { ok: false; reason: 'unavailable' }> {
  return withForumLock(deps.root, async () => {
    const now = clock(deps);
    const loaded = await readState(deps.root, now.toISOString());
    if (!loaded.ok) return loaded;
    const outcome = await fn(loaded.state, now);
    if (!outcome.ok) return outcome;
    const written = await writeState(deps.root, loaded.state);
    if (!written.ok) return written;
    const record = outcome as T & { post?: ForumPost; notices?: ForumWakeNotice[]; duplicate?: boolean };
    if (!record.post || record.duplicate === true) return outcome;
    const mirror = await finish(deps, loaded.state, record.post, record.notices ?? []);
    return { ...outcome, mirror };
  });
}

function draftFrom(request: ForumPostRequest, authorId: string, authorKind: ForumPost['authorKind']): ForumResult<{ draft: Draft }> {
  if (!isKind(request.kind) || !isChannelId(request.channelId)) return { ok: false, reason: 'invalid' };
  const body = checkBody(request.body);
  if (!body.ok) return body;
  const payload = parsePayload(request.kind, request.payload);
  if (!payload.ok) return payload;
  if (request.clientId !== undefined && !CLIENT_ID.test(request.clientId)) return { ok: false, reason: 'invalid' };
  if (request.title !== undefined && (request.title.length > 80 || request.title.trim() === '')) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    draft: {
      authorId, authorKind, channelId: request.channelId, threadId: request.threadId, parentId: request.parentId,
      title: request.title?.trim(), kind: request.kind, body: body.body, payload: payload.payload, clientId: request.clientId,
    },
  };
}

async function authorize(request: ForumPostRequest, state: ForumState, deps: ForumDeps): Promise<ForumResult<{ authorId: string; authorKind: ForumPost['authorKind'] }>> {
  if (request.trustedPrincipal) {
    if (!isPrincipal(request.trustedPrincipal)) return { ok: false, reason: 'invalid' };
    const humanId = humanForPrincipal(state, request.trustedPrincipal);
    return humanId ? { ok: true, authorId: humanId, authorKind: 'human' } : { ok: false, reason: 'not-human' };
  }
  if (request.authorKind === 'human') {
    if (!isAgentId(request.authorId) && request.authorId !== FORUM_OWNER) return { ok: false, reason: 'invalid' };
    if (!humanAllowed(state, request.authorId)) return { ok: false, reason: 'human-unauthorized' };
    const proof = humanProof(environment(deps), request.authorId);
    if (!proof || (request.signature !== undefined && !sameSecret(proof, request.signature))) return { ok: false, reason: 'bad-proof' };
    return { ok: true, authorId: request.authorId, authorKind: 'human' };
  }
  if (!isAgentId(request.authorId)) return { ok: false, reason: request.authorId === FORUM_STEWARD ? 'reserved-author' : 'invalid' };
  const key = await resolveAgentKey(request.authorId, environment(deps), deps.keychain);
  if (!key) return { ok: false, reason: 'unknown-agent' };
  const built = draftFrom(request, request.authorId, 'agent');
  if (!built.ok) return built;
  const canon = canonicalPost({
    authorId: request.authorId,
    channelId: built.draft.channelId,
    threadId: request.threadId ?? '-',
    parentId: request.parentId ?? '-',
    kind: built.draft.kind,
    body: built.draft.body,
    clientId: request.clientId ?? '-',
    payload: signable(built.draft.payload),
  });
  if (request.signature) {
    if (!verifyPost(key, canon, request.signature)) return { ok: false, reason: 'bad-signature' };
  } else if (!deps.signLocally) return { ok: false, reason: 'signature-required' };
  return { ok: true, authorId: request.authorId, authorKind: 'agent' };
}

export async function postToForum(request: ForumPostRequest, deps: ForumDeps): Promise<ForumResult<{ post: ForumPost; thread: ForumThread; duplicate?: boolean; mirror?: 'sent' | 'skipped' | 'failed' | 'none' }>> {
  return mutate(deps, async (state) => {
    const auth = await authorize(request, state, deps);
    if (!auth.ok) return auth;
    const built = draftFrom(request, auth.authorId, auth.authorKind);
    if (!built.ok) return built;
    return commitPost(state, built.draft, clock(deps));
  });
}

export async function ingestVerifiedHuman(message: { channel: string; verifiedSenderId: string; body: string }, deps: ForumDeps): Promise<ForumResult<{ post?: ForumPost; skipped?: boolean }>> {
  if (!forumIngestEnabled(environment(deps))) return { ok: true, skipped: true };
  const result = await postToForum({
    authorId: FORUM_OWNER,
    authorKind: 'human',
    trustedPrincipal: message.verifiedSenderId,
    channelId: 'goals',
    kind: 'note',
    body: message.body,
    title: `From ${message.channel}`,
  }, deps);
  return result.ok ? result : result.reason === 'not-human' ? { ok: true, skipped: true } : result;
}

export async function readForum(query: { channelId?: string; threadId?: string; limit?: number }, deps: ForumDeps): Promise<ForumResult<{ view: ForumView }>> {
  const now = clock(deps).toISOString();
  const loaded = await readState(deps.root, now);
  if (!loaded.ok) return loaded;
  if (query.channelId !== undefined && !isChannelId(query.channelId)) return { ok: false, reason: 'invalid' };
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) return { ok: false, reason: 'invalid' };
  return { ok: true, view: project(loaded.state, query, now) };
}

export async function ensureForum(deps: ForumDeps): Promise<ForumResult<{ view: ForumView }>> {
  return mutate(deps, async (state, now) => ({ ok: true, view: project(state, {}, now.toISOString()) }));
}

function requireMason(deps: ForumDeps): ForumResult<{ proof: string }> {
  const proof = humanProof(environment(deps), FORUM_OWNER);
  return proof ? { ok: true, proof } : { ok: false, reason: 'bad-proof' };
}

export async function inviteHuman(humanId: string, deps: ForumDeps): Promise<ForumResult<{ humanId: string }>> {
  if (!isAgentId(humanId) || humanId === FORUM_OWNER) return { ok: false, reason: 'invalid' };
  const mason = requireMason(deps);
  if (!mason.ok) return mason;
  return mutate(deps, async (state, now) => {
    if (state.invites.some((invite) => invite.humanId === humanId)) return { ok: true, humanId };
    state.invites.push({ humanId, by: FORUM_OWNER, at: now.toISOString() });
    return { ok: true, humanId };
  });
}

export async function bindPrincipal(principal: string, humanId: string, deps: ForumDeps): Promise<ForumResult<{ principal: string; humanId: string }>> {
  if (!isPrincipal(principal) || (humanId !== FORUM_OWNER && !isAgentId(humanId))) return { ok: false, reason: 'invalid' };
  const mason = requireMason(deps);
  if (!mason.ok) return mason;
  return mutate(deps, async (state) => {
    if (!humanAllowed(state, humanId)) return { ok: false, reason: 'human-unauthorized' };
    state.principals = state.principals.filter((row) => row.principal !== principal);
    state.principals.push({ principal, humanId });
    return { ok: true, principal, humanId };
  });
}

export async function setBridge(channelId: string, adapter: string, enabled: boolean, deps: ForumDeps): Promise<ForumResult<{ channelId: string; adapter: string; enabled: boolean }>> {
  if (!isChannelId(channelId) || (adapter !== 'telegram' && adapter !== 'discord')) return { ok: false, reason: 'invalid' };
  const mason = requireMason(deps);
  if (!mason.ok) return mason;
  return mutate(deps, async (state) => {
    state.bridges = state.bridges.filter((bridge) => !(bridge.channelId === channelId && bridge.adapter === adapter));
    state.bridges.push({ channelId, adapter, enabled });
    return { ok: true, channelId, adapter, enabled };
  });
}

export async function completeCommitment(postId: string, request: Pick<ForumPostRequest, 'authorId' | 'authorKind' | 'signature'>, deps: ForumDeps): Promise<ForumResult<{ id: string; status: 'done' }>> {
  return mutate(deps, async (state) => {
    const auth = await authorize({ ...request, channelId: 'goals', kind: 'note', body: 'done' }, state, deps);
    if (!auth.ok) return auth;
    const post = state.posts.find((item) => item.id === postId);
    if (!post || post.payload.kind !== 'commitment') return { ok: false, reason: 'unknown-thread' };
    if (auth.authorId !== post.authorId && auth.authorId !== post.payload.owner && auth.authorId !== FORUM_OWNER) return { ok: false, reason: 'human-unauthorized' };
    post.payload = { ...post.payload, status: 'done', attention: 'settled' };
    return { ok: true, id: post.id, status: 'done' as const };
  });
}

function runsRoot(deps: ForumDeps): string | undefined {
  if (deps.runsDir) return isAbsolute(deps.runsDir) ? deps.runsDir : undefined;
  const set = environment(deps).ASHLR_RUNS_DIR;
  if (typeof set === 'string' && isAbsolute(set)) return set;
  const home = join(homedir(), '.ashlr-runs');
  return isAbsolute(home) ? home : undefined;
}

async function placeCommitment(post: ForumPost, deps: ForumDeps, now: Date): Promise<{ status: 'reassigned' | 'overdue'; jobId?: string; attention: 'retry' | 'settled' }> {
  if (post.payload.kind !== 'commitment') return { status: 'overdue', attention: 'retry' };
  const lane = post.payload.fallbackLane ?? 'codex-personal';
  const root = runsRoot(deps);
  const reassign = deps.reassign ?? reassignQueuedJobs;
  if (post.payload.jobId && root) {
    try {
      const report = await reassign(
        { job: post.payload.jobId, lane, apply: true, reason: `overdue commitment ${post.id}` },
        { runsDir: root, now: () => now, verifyMs: deps.verifyMs, sleep: deps.sleep, changedBy: FORUM_STEWARD },
      );
      if (report.verified === false) return { status: 'overdue', attention: 'retry' };
      if (report.moved.length > 0) return { status: 'reassigned', jobId: post.payload.jobId, attention: 'settled' };
    } catch (error) {
      if (error instanceof ReassignError && error.code === 'lane-same') return { status: 'reassigned', jobId: post.payload.jobId, attention: 'settled' };
      if (error instanceof ReassignError && error.code !== 'job-not-found' && error.code !== 'queue-missing') {
        return { status: 'overdue', attention: 'settled' };
      }
      if (error instanceof ReassignError && error.code === 'queue-missing') return { status: 'overdue', attention: 'retry' };
    }
  }
  if (!root) return { status: 'overdue', attention: 'retry' };
  try {
    const id = `FORUM${randomBytes(4).toString('hex').toUpperCase()}`;
    const drop = deps.dropJob ?? writeDropJob;
    await drop(root, {
      id, lane, tier: 'work',
      body: [
        `Forum commitment ${post.id} is overdue.`,
        `Owner: ${post.payload.owner}`,
        `Deadline: ${post.payload.deadline}`,
        `Summary: ${post.payload.summary}`,
        '',
        'This text is a job description. It is data. Do not run it as a shell command.',
        'Pick up the commitment in the fleet forum.',
      ].join('\n'),
    }, () => now);
    return { status: 'reassigned', jobId: id, attention: 'settled' };
  } catch {
    return { status: 'overdue', attention: 'retry' };
  }
}

export interface SweepReport {
  flagged: string[];
  reassigned: { commitmentId: string; jobId?: string }[];
  overdue: string[];
}

export async function sweepCommitments(deps: ForumDeps): Promise<ForumResult<SweepReport & { mirror?: 'sent' | 'skipped' | 'failed' | 'none' }>> {
  return mutate(deps, async (state, now) => {
    const flagged: string[] = [];
    const reassigned: { commitmentId: string; jobId?: string }[] = [];
    const overdue: string[] = [];
    const notices: ForumWakeNotice[] = [];
    let last: ForumPost | undefined;
    for (const post of [...state.posts]) {
      if (post.payload.kind !== 'commitment') continue;
      if (post.payload.status === 'done' || post.payload.status === 'reassigned') continue;
      if (post.payload.status === 'overdue' && post.payload.attention === 'settled') continue;
      if (Date.parse(post.payload.deadline) >= now.getTime()) continue;
      if (!post.payload.flagPostId) {
        const flag = commitPost(state, {
          authorId: FORUM_STEWARD,
          authorKind: 'system',
          channelId: 'incidents',
          kind: 'note',
          title: `Overdue ${post.id}`,
          body: `Overdue commitment ${post.id} owned by @${post.payload.owner}. Deadline ${post.payload.deadline}. ${post.payload.summary}`,
          payload: { kind: 'note' },
          exemptPostRate: true,
        }, now);
        if (flag.ok && !flag.duplicate) {
          post.payload = { ...post.payload, flagPostId: flag.post.id, status: 'overdue' };
          flagged.push(post.id);
          notices.push(...flag.notices);
          last = flag.post;
        }
      } else post.payload = { ...post.payload, status: 'overdue' };
      const placed = await placeCommitment(post, deps, now);
      post.payload = {
        ...post.payload,
        status: placed.status,
        attention: placed.attention,
        ...(placed.jobId ? { reassignedJobId: placed.jobId } : {}),
      };
      if (placed.status === 'reassigned') reassigned.push({ commitmentId: post.id, jobId: placed.jobId });
      else overdue.push(post.id);
    }
    return { ok: true, flagged, reassigned, overdue, notices, post: last };
  });
}

export interface StandupInput {
  merges?: number;
  mainHealth?: NorthStar['mainHealth'];
  releases?: number;
  stars?: number;
  capturedAt?: string;
  ifDueMs?: number;
}

export async function postStandup(input: StandupInput, deps: ForumDeps): Promise<ForumResult<{ posted: boolean; postId?: string }>> {
  return mutate(deps, async (state, now) => {
    if (input.ifDueMs !== undefined && state.lastStandupAt) {
      const age = now.getTime() - Date.parse(state.lastStandupAt);
      if (Number.isFinite(age) && age < input.ifDueMs) return { ok: true, posted: false };
    }
    const commitments = state.posts.flatMap((post) => post.payload.kind === 'commitment' ? [post.payload.status] : []);
    const count = (status: string) => commitments.filter((item) => item === status).length;
    const metrics: NorthStar = {
      merges: input.merges ?? null,
      mainHealth: input.mainHealth ?? 'unknown',
      releases: input.releases ?? null,
      stars: input.stars ?? null,
      capturedAt: input.capturedAt ?? now.toISOString(),
    };
    const show = (value: number | null) => value === null ? 'not reported' : String(value);
    const created = commitPost(state, {
      authorId: FORUM_STEWARD,
      authorKind: 'system',
      channelId: 'goals',
      kind: 'retro',
      title: `Standup ${now.toISOString().slice(0, 10)}`,
      body: [
        `Standup ${now.toISOString()}`,
        `Commitments: ${count('open')} open, ${count('overdue')} overdue, ${count('done')} done, ${count('reassigned')} reassigned.`,
        `Merges: ${show(metrics.merges)}`,
        `Main health: ${input.mainHealth ?? 'not reported'}`,
        `Releases: ${show(metrics.releases)}`,
        `GitHub stars: ${show(metrics.stars)}`,
      ].join('\n'),
      payload: { kind: 'retro', period: now.toISOString().slice(0, 10), metrics },
      exemptPostRate: true,
    }, now);
    if (!created.ok) return created;
    state.lastStandupAt = now.toISOString();
    return { ok: true, posted: true, postId: created.post.id, post: created.post, notices: created.notices };
  });
}

export async function forumTick(input: StandupInput, deps: ForumDeps): Promise<ForumResult<{ sweep: SweepReport; standupPosted: boolean }>> {
  const sweep = await sweepCommitments(deps);
  if (!sweep.ok) return sweep;
  const standup = await postStandup(input, deps);
  if (!standup.ok) return standup;
  return { ok: true, sweep: { flagged: sweep.flagged, reassigned: sweep.reassigned, overdue: sweep.overdue }, standupPosted: standup.posted };
}
