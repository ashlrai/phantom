/** Narrow the forum read route. Unknown shapes are null, never a guessed board. */
export interface ForumChannelView { id: string; title: string; purpose: string; posts: number; overdue: number }
export interface ForumPostView {
  id: string; authorId: string; authorKind: string; kind: string; body: string;
  createdAt: string; threadTitle: string; channelId: string;
}
export interface ForumCommitmentView { id: string; owner: string; deadline: string; status: string; summary: string }
export interface ForumView {
  v: 1;
  channels: ForumChannelView[];
  posts: ForumPostView[];
  commitments: ForumCommitmentView[];
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function narrowForum(value: unknown): ForumView | null {
  const body = row(value);
  if (!body || body.v !== 1 || !Array.isArray(body.channels) || !Array.isArray(body.posts) || !Array.isArray(body.commitments)) return null;
  const channels: ForumChannelView[] = [];
  for (const item of body.channels) {
    const channel = row(item);
    if (!channel || !text(channel.id) || !text(channel.title) || !text(channel.purpose) || typeof channel.posts !== 'number' || typeof channel.overdue !== 'number') return null;
    channels.push({ id: channel.id, title: channel.title, purpose: channel.purpose, posts: channel.posts, overdue: channel.overdue });
  }
  const posts: ForumPostView[] = [];
  for (const item of body.posts) {
    const post = row(item);
    if (!post || !text(post.id) || !text(post.authorId) || !text(post.authorKind) || !text(post.kind) || !text(post.body) || !text(post.createdAt) || !text(post.threadTitle) || !text(post.channelId)) return null;
    posts.push({ id: post.id, authorId: post.authorId, authorKind: post.authorKind, kind: post.kind, body: post.body, createdAt: post.createdAt, threadTitle: post.threadTitle, channelId: post.channelId });
  }
  const commitments: ForumCommitmentView[] = [];
  for (const item of body.commitments) {
    const commitment = row(item);
    if (!commitment || !text(commitment.id) || !text(commitment.owner) || !text(commitment.deadline) || !text(commitment.status) || !text(commitment.summary)) return null;
    commitments.push({ id: commitment.id, owner: commitment.owner, deadline: commitment.deadline, status: commitment.status, summary: commitment.summary });
  }
  return { v: 1, channels, posts, commitments };
}

export function overdueCommitments(view: ForumView): ForumCommitmentView[] {
  return view.commitments.filter((commitment) => commitment.status === 'overdue' || commitment.status === 'reassigned');
}
