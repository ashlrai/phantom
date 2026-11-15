/**
 * One MCP call for the fleet forum. Read ops stay available when the kill
 * switch is on; writes are refused by the native-tool gate.
 */
import { isAbsolute } from 'node:path';
import {
  completeCommitment, forumRoot, forumTick, inviteHuman,
  postStandup, postToForum, readForum, setBridge, sweepCommitments,
  type ForumDeps, type StandupInput,
} from './service.js';

const READ = new Set(['channels', 'read', 'commitments']);

export function forumToolIsRead(args: Record<string, unknown>): boolean {
  return READ.has(String(args.op)) && !(args.op === 'commitments' && args.done === true);
}

function deps(args: Record<string, unknown>): ForumDeps {
  const env = process.env;
  const runsDir = typeof args.runsDir === 'string' && isAbsolute(args.runsDir) ? args.runsDir : undefined;
  return { root: forumRoot(env), env, signLocally: true, runsDir };
}

function metrics(value: unknown): StandupInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const input: StandupInput = {};
  if (typeof row.merges === 'number') input.merges = row.merges;
  if (typeof row.releases === 'number') input.releases = row.releases;
  if (typeof row.stars === 'number') input.stars = row.stars;
  if (row.mainHealth === 'green' || row.mainHealth === 'red' || row.mainHealth === 'unknown') input.mainHealth = row.mainHealth;
  if (typeof row.capturedAt === 'string') input.capturedAt = row.capturedAt;
  if (typeof row.ifDueMs === 'number') input.ifDueMs = row.ifDueMs;
  return input;
}

/** Handler result. `{ error }` is a refusal. Posts are never executed. */
export async function handleForumTool(args: Record<string, unknown>): Promise<unknown> {
  const op = args.op;
  const forum = deps(args);
  switch (op) {
    case 'channels':
      return readForum({}, forum);
    case 'read':
      return readForum({
        channelId: typeof args.channel === 'string' ? args.channel : undefined,
        threadId: typeof args.thread === 'string' ? args.thread : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }, forum);
    case 'commitments':
      if (args.done === true) {
        if (typeof args.id !== 'string' || typeof args.author !== 'string') return { error: 'invalid' };
        return completeCommitment(args.id, { authorId: args.author, authorKind: 'agent' }, forum);
      }
      return readForum({}, forum).then((result) => result.ok ? { ok: true, commitments: result.view.commitments } : result);
    case 'post':
    case 'reply':
      if (typeof args.author !== 'string' || typeof args.channel !== 'string' || typeof args.kind !== 'string' || typeof args.body !== 'string') {
        return { error: 'invalid' };
      }
      return postToForum({
        authorId: args.author,
        authorKind: 'agent',
        channelId: args.channel,
        threadId: typeof args.thread === 'string' ? args.thread : undefined,
        parentId: typeof args.parent === 'string' ? args.parent : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
        kind: args.kind,
        body: args.body,
        payload: args.payload,
        clientId: typeof args.clientId === 'string' ? args.clientId : undefined,
        signature: typeof args.signature === 'string' ? args.signature : undefined,
      }, forum);
    case 'invite':
      return typeof args.member === 'string' ? inviteHuman(args.member, forum) : { error: 'invalid' };
    case 'bridge':
      return typeof args.channel === 'string' && typeof args.adapter === 'string'
        ? setBridge(args.channel, args.adapter, args.enabled !== false, forum)
        : { error: 'invalid' };
    case 'sweep':
      return sweepCommitments(forum);
    case 'standup':
      return postStandup(metrics(args.metrics), forum);
    case 'tick':
      return forumTick(metrics(args.metrics), forum);
    default:
      return { error: 'invalid' };
  }
}
