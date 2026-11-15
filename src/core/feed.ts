import { listProposalsDetailed } from './inbox/store.js';
import { realizedMergeOf } from './inbox/realized-merge.js';
import { readPlanLogReplies, replyTime } from './fleet/mason-outbox.js';

export interface FeedItem { kind: 'merge' | 'leader-reply'; at: string; text: string }
export interface FeedReport {
  schema: 'phantom.feed.v1';
  items: FeedItem[];
  sources: Record<'merges' | 'releases' | 'incidents' | 'leaderReplies', 'available' | 'unknown'>;
}

/** Combine observed events before applying the limit. Invalid dates cannot be ordered. */
export function orderFeed(items: FeedItem[], limit: number): FeedItem[] {
  return items.filter(item => Number.isFinite(Date.parse(item.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

export async function readFeed(limit = 30): Promise<FeedReport> {
  const items: FeedItem[] = [];
  const sources: FeedReport['sources'] = { merges: 'unknown', releases: 'unknown', incidents: 'unknown', leaderReplies: 'unknown' };
  try {
    const read = listProposalsDetailed();
    if (read.complete && read.sourceState !== 'degraded') {
      sources.merges = 'available';
      for (const proposal of read.proposals) {
        const evidence = realizedMergeOf(proposal);
        if (!evidence) continue;
        const at = evidence.source === 'github-host' ? evidence.reconciliation.observedAt : evidence.observedAt;
        items.push({ kind: 'merge', at, text: `Merged in ${proposal.repo ?? 'unknown repo'}` });
      }
    }
  } catch { /* unavailable stays unknown */ }
  try {
    const replies = await readPlanLogReplies({ limit: 1000 });
    if (replies.sourceState === 'healthy') sources.leaderReplies = 'available';
    for (const reply of replies.entries) {
      const at = replyTime(reply.at);
      if (Number.isFinite(at)) items.push({ kind: 'leader-reply', at: new Date(at).toISOString(), text: reply.text });
    }
  } catch { /* unavailable stays unknown */ }
  return { schema: 'phantom.feed.v1', items: orderFeed(items, limit), sources };
}
