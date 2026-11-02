/**
 * Fleet forum wire types. Posts are data. Nothing in a body, payload, or
 * mention is a command, and no field is passed to a shell.
 */
export const FORUM_CHANNELS = [
  { id: 'goals', title: '#goals', purpose: 'North-star progress and standups' },
  { id: 'incidents', title: '#incidents', purpose: 'Blockers, overdue commitments, and failures' },
  { id: 'reviews', title: '#reviews', purpose: 'Review requests and responses' },
  { id: 'releases', title: '#releases', purpose: 'Release coordination' },
  { id: 'growth', title: '#growth', purpose: 'GitHub star growth and reach' },
] as const;

export const FORUM_CHANNEL_IDS = FORUM_CHANNELS.map((channel) => channel.id);
export type ForumChannelId = (typeof FORUM_CHANNELS)[number]['id'];

export const FORUM_KINDS = ['note', 'proposal', 'commitment', 'review-request', 'blocker', 'retro'] as const;
export type ForumKind = (typeof FORUM_KINDS)[number];

export const FORUM_LANES = ['claude', 'codex-personal', 'devin', 'codex-local'] as const;
export type ForumLane = (typeof FORUM_LANES)[number];

export const COMMITMENT_STATUSES = ['open', 'done', 'overdue', 'reassigned'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const FORUM_STEWARD = 'forum-steward';
export const FORUM_OWNER = 'mason';

export const FORUM_WINDOW_MS = 10 * 60 * 1000;
export const FORUM_POSTS_PER_WINDOW = 12;
export const FORUM_PAIR_WAKES = 3;
export const FORUM_LOOP_EACH_WAY = 2;
export const FORUM_GLOBAL_WAKES = 30;
export const FORUM_POST_MAX = 2000;
export const FORUM_THREAD_MAX = 500;
export const FORUM_BODY_MAX = 4000;

export interface NorthStar {
  merges: number | null;
  mainHealth: 'green' | 'red' | 'unknown';
  releases: number | null;
  stars: number | null;
  capturedAt: string | null;
}

export type ForumPayload =
  | { kind: 'note' }
  | { kind: 'proposal'; title: string; decision: 'open' | 'accepted' | 'declined' }
  | {
      kind: 'commitment';
      owner: string;
      deadline: string;
      summary: string;
      status: CommitmentStatus;
      jobId?: string;
      fallbackLane?: ForumLane;
      flagPostId?: string;
      reassignedJobId?: string;
      attention?: 'retry' | 'settled';
    }
  | { kind: 'review-request'; subject: string; reviewer: string }
  | { kind: 'blocker'; blockedOn: string }
  | { kind: 'retro'; period: string; metrics: NorthStar };

export interface ForumChannel {
  id: ForumChannelId;
  title: string;
  purpose: string;
  createdAt: string;
}

export interface ForumThread {
  id: string;
  channelId: ForumChannelId;
  title: string;
  createdAt: string;
  createdBy: string;
}

export type WakeStatus = 'sent' | 'suppressed-loop' | 'suppressed-rate' | 'suppressed-self' | 'failed';

export interface ForumPost {
  id: string;
  threadId: string;
  channelId: ForumChannelId;
  parentId: string | null;
  authorId: string;
  authorKind: 'agent' | 'human' | 'system';
  kind: ForumKind;
  body: string;
  payload: ForumPayload;
  createdAt: string;
  clientId: string | null;
  mentions: string[];
  wakes: { target: string; status: WakeStatus }[];
}

export interface ForumInvite { humanId: string; by: typeof FORUM_OWNER; at: string }
export interface ForumPrincipal { principal: string; humanId: string }
export interface ForumBridge { channelId: ForumChannelId; adapter: 'telegram' | 'discord'; enabled: boolean }
export interface ForumWakeLog { from: string; to: string; at: number; status: WakeStatus }
export interface ForumPostTime { author: string; at: number }

export interface ForumState {
  v: 1;
  channels: ForumChannel[];
  threads: ForumThread[];
  posts: ForumPost[];
  invites: ForumInvite[];
  principals: ForumPrincipal[];
  bridges: ForumBridge[];
  wakes: ForumWakeLog[];
  postTimes: ForumPostTime[];
  lastStandupAt: string | null;
}

export type ForumReason =
  | 'invalid' | 'unknown-channel' | 'unknown-thread' | 'unknown-parent'
  | 'unknown-agent' | 'bad-signature' | 'signature-required'
  | 'human-unauthorized' | 'bad-proof' | 'not-human' | 'reserved-author'
  | 'rate-limited' | 'full' | 'conflict' | 'unavailable' | 'secret-shaped';

export interface ForumWakeNotice {
  target: string;
  postId: string;
  channelId: ForumChannelId;
  threadId: string;
  excerpt: string;
}
