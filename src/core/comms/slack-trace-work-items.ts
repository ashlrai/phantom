/** Join Slack request-trace rows with fleet claims into work-item evidence for
 * `classifyWorkItem` (Nov12 22:29 ET reporting contract). Pure: no I/O, no clock.
 *
 * The claim store records a Slack reference only as a claim-thread binding
 * (`slack:<team>:<channel>:<rootTs>` or `<team>/<channel>/<threadTs>`), so a
 * claim references a request through its thread root, not a message ts. A claim
 * record carries no running, blocker or verified evidence, so those stay unset.
 * `answered` reply transport is never RUNNING or VERIFIED evidence. */
import { parseSlackThreadRef, isSlackChannelId, isSlackTeamId, isSlackTs } from '../agents/slack-network.js';
import type { SlackTraceRow } from '../agents/slack-request-trace.js';
import type { WorkItemEvidence } from './work-item-state.js';

/** One live fleet claim joined to the Slack thread it is bound to. */
export interface SlackTraceClaim { claimId: string; repo: string; agent: string; threadKey: string }

function decimalTimestamp(ts: string): string | undefined {
  if (!isSlackTs(ts)) return undefined;
  const [seconds, fraction] = ts.split('.') as [string, string];
  return `${seconds.replace(/^0+/, '') || '0'}.${fraction.replace(/0+$/, '')}`;
}

function threadOf(ref: string): { teamId: string; channelId: string; threadTs: string } | undefined {
  const parsed = parseSlackThreadRef(ref);
  if (parsed) return { teamId: parsed.teamId, channelId: parsed.channelId, threadTs: parsed.rootTs };
  const parts = ref.split('/');
  if (parts.length === 3 && isSlackTeamId(parts[0]) && isSlackChannelId(parts[1]) && isSlackTs(parts[2])) {
    return { teamId: parts[0]!, channelId: parts[1]!, threadTs: parts[2]! };
  }
  return undefined;
}

export function slackTraceRowsToWorkItems(
  rows: readonly SlackTraceRow[],
  claims: readonly SlackTraceClaim[],
): WorkItemEvidence[] {
  const byThread = new Map<string, Map<string, SlackTraceClaim>>();
  for (const claim of claims) {
    const thread = threadOf(claim.threadKey);
    if (!thread || !claim.repo.trim() || !claim.agent.trim() || !claim.claimId.trim()) continue;
    const key = `${thread.channelId}:${decimalTimestamp(thread.threadTs)!}`;
    const candidates = byThread.get(key) ?? new Map<string, SlackTraceClaim>();
    const identity = JSON.stringify([thread.teamId, claim.repo, claim.claimId, claim.agent]);
    candidates.set(identity, claim);
    byThread.set(key, candidates);
  }
  return rows.map((row) => {
    const timestamp = decimalTimestamp(row.threadTs);
    const candidates = timestamp === undefined ? undefined : byThread.get(`${row.channelId}:${timestamp}`);
    const claim = candidates?.size === 1 ? candidates.values().next().value : undefined;
    return {
      id: `slack:${row.channelId}:${row.messageTs}`,
      ...(row.ingress !== 'unknown' ? { receivedAt: row.at } : {}),
      ...(claim ? { owner: claim.agent, claimReceipt: `${claim.repo}#${claim.claimId}` } : {}),
    };
  });
}
