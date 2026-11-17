import { listProposalsDetailed } from './inbox/store.js';
import { realizedMergeOf } from './inbox/realized-merge.js';
import { parseOutbox, readPlanLogReplies, replyTime } from './fleet/mason-outbox.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAgentActivity } from './fleet/agent-activity.js';
import { readFleetBusFeed } from './fleet/bus-feed.js';
import { readSource } from './fleet/runs-parked-queue.js';
import { validMilestoneTag } from './fleet/release-live-notice.js';
import { scrubSecrets } from './util/scrub.js';

export interface FeedItem { kind: 'merge' | 'release' | 'blocked' | 'leader-reply'; at: string; text: string; id?: string; href?: string }
export interface FeedReport {
  schema: 'phantom.feed.v1';
  items: FeedItem[];
  sources: Record<'merges' | 'releases' | 'incidents' | 'leaderReplies', 'available' | 'unknown'>;
}

/** Combine observed events before applying the limit. Invalid dates cannot be ordered. */
export function orderFeed(items: FeedItem[], limit: number, sinceMs = -Infinity, now = Infinity): FeedItem[] {
  const seen = new Set<string>();
  return items.filter(item => Number.isFinite(Date.parse(item.at)) && Date.parse(item.at) >= sinceMs && Date.parse(item.at) <= now)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter(item => {
      const key = item.id ?? `${item.kind}:${item.at}:${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, limit);
}

/** The CLI and HTTP route accept the same bounded window, including its boundary. */
export function parseFeedQuery(limit = '30', since?: string, now = Date.now()): { limit: number; sinceMs?: number } | null {
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000) return null;
  if (since === undefined) return { limit: Number(limit) };
  const match = /^([1-9]\d*)(m|h|d)$/.exec(since);
  const duration = match ? Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'] : NaN;
  return duration > 0 && duration <= 7 * 86_400_000 ? { limit: Number(limit), sinceMs: now - duration } : null;
}

export async function readFeed(limit = 30, opts: { sinceMs?: number; now?: number; runsDir?: string } = {}): Promise<FeedReport> {
  const now = opts.now ?? Date.now();
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const items: FeedItem[] = [];
  const sources: FeedReport['sources'] = { merges: 'unknown', releases: 'unknown', incidents: 'unknown', leaderReplies: 'unknown' };
  const add = (kind: FeedItem['kind'], id: string, at: string, text: string, href: string): void => {
    if (scrubSecrets(id) !== id || scrubSecrets(href) !== href) return;
    items.push({ kind, id: `${kind}:${id}`, at, text: scrubSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 400), href });
  };
  try {
    const read = listProposalsDetailed();
    if (read.complete && read.sourceState !== 'degraded') {
      sources.merges = 'available';
      for (const proposal of read.proposals) {
        const evidence = realizedMergeOf(proposal);
        if (!evidence) continue;
        const at = evidence.source === 'github-host' ? evidence.mergedAt : evidence.observedAt;
        const href = evidence.source === 'github-host' ? evidence.prUrl : '/verse/?pane=fleet-merges';
        add('merge', evidence.source === 'github-host' ? href : proposal.id, at, `Merged in ${proposal.repo ?? 'unknown repo'}`, href);
      }
    }
  } catch { /* unavailable stays unknown */ }
  const [activityRead, busRead, releaseRead, replyRead] = await Promise.allSettled([
    readAgentActivity({ runsDir, limit: 500, windowMs: 7 * 86_400_000, now: () => now }),
    readFleetBusFeed({ runsDir, limit: 500 }),
    readSource(join(runsDir, 'leader', 'MASON-OUTBOX.md'), 256 * 1024, true),
    readPlanLogReplies({ limit: 1000, ...(opts.runsDir ? { file: join(runsDir, 'leader', 'PLAN-LOG.md') } : {}) }),
  ]);
  if (activityRead.status === 'fulfilled') {
    const activity = activityRead.value;
    sources.merges = activity.sourceState === 'healthy' ? 'available' : 'unknown';
    for (const job of activity.jobs) if (job.outcome?.toUpperCase() === 'MERGED' && job.outcomeAt) {
      add('merge', job.url ?? job.job, job.outcomeAt, `Merged ${job.job}${job.repo ? ` in ${job.repo}` : ''}`, job.url ?? '/verse/?pane=fleet-merges');
    }
  }
  if (busRead.status === 'fulfilled') {
    if (busRead.value.sources.events === 'healthy') sources.incidents = 'available';
    for (const event of busRead.value.events) {
      const blocked = /^PARKED ([A-Za-z0-9][A-Za-z0-9._-]{0,79}) \[precheck code=13 reason=(.+)\]$/.exec(event.text);
      if (event.kind === 'blocked' && event.atIso && blocked) add('blocked', `${event.atIso}:${blocked[1]}`, event.atIso,
        `${blocked[1]} blocked: ${blocked[2]!.replace(/_/g, ' ')}`, '/verse/?pane=fleet-bus');
    }
  }
  if (releaseRead.status === 'fulfilled') {
    if (releaseRead.value.state === 'healthy') sources.releases = 'available';
    // These are durable publication announcements, not refresh times or proof of installation.
    for (const notice of parseOutbox(releaseRead.value.text, 1000)) {
      const release = /(?:^|\n)Release (?:live|published): ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) (\S+)$/.exec(notice.text);
      if (release && validMilestoneTag(release[2]!)) add('release', `${release[1]}@${release[2]}`, notice.at,
        `Release announced: ${release[1]} ${release[2]}`, `https://github.com/${release[1]}/releases/tag/${encodeURIComponent(release[2]!)}`);
    }
  }
  if (replyRead.status === 'fulfilled') {
    const replies = replyRead.value;
    if (replies.sourceState === 'healthy') sources.leaderReplies = 'available';
    for (const reply of replies.entries) {
      const at = replyTime(reply.at);
      if (Number.isFinite(at) && reply.text.trim()) add('leader-reply', reply.id ?? `${at}:${reply.text.slice(0, 80)}`, new Date(at).toISOString(), reply.text, '/verse/?pane=leader-thread');
    }
  }
  return { schema: 'phantom.feed.v1', items: orderFeed(items, limit, opts.sinceMs, now), sources };
}
