import type { AgentProfile } from './agent-profile.js';
export interface SendDecision { decision: 'allow' | 'draft' | 'deny'; reason: string; }
/** Pure fail-closed policy. A portable profile cannot prove a verified self identity. */
export function checkSend(profile: AgentProfile, channel: string, recipient: string, countToday: number): SendDecision {
  const result = (decision: SendDecision['decision'], reason: string): SendDecision => ({ decision, reason });
  if (!profile.channels.includes(channel)) return result('deny', 'channel-not-listed');
  if (profile.policy.recipients.deny.includes(recipient)) return result('deny', 'recipient-denied');
  if (!Number.isSafeInteger(countToday) || countToday < 0) return result('deny', 'invalid-daily-count');
  if (profile.policy.limitsTodo) return result('draft', 'limits-incomplete');
  if (profile.policy.dailyCap !== null && countToday >= profile.policy.dailyCap) return result('draft', 'daily-cap-reached');
  if (profile.policy.send === 'drafts-only') return result('draft', 'drafts-only');
  if (profile.policy.perMessageApproval) return result('draft', 'approval-required');
  return result('draft', 'verified-self-evidence-required');
}
