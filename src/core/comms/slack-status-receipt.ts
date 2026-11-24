/** Read-only status for one exact Slack ingress receipt, never a thread sibling. */
import { collectBusWorkItemEvidence } from './work-item-bus-evidence.js';
import { classifyWorkItem, type WorkItemState } from './work-item-state.js';
import { scrubSecrets } from '../util/scrub.js';

export interface SlackStatusReceipt {
  receiptId: string | null;
  state: WorkItemState;
  owner: string | null;
  claimReceipt: string | null;
  asOf: string;
  source: string;
  text: string;
}

const safe = (value: string): string => scrubSecrets(value)
  .replace(/[\r\n\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/[<>&]/g, '?').slice(0, 300);

/** Reuse the fleet's persisted evidence and classifier; this never creates a receipt. */
export function readSlackStatusReceipt(id: string, options: { root: string; now: number }): SlackStatusReceipt {
  const asOf = new Date(options.now).toISOString();
  const { evidence, sources } = collectBusWorkItemEvidence(id, options);
  const classified = classifyWorkItem(evidence, asOf);
  const receiptId = sources.inbox === 'found' ? id : null;
  const dependency = receiptId === null ? `bus-inbox/messages.json (${sources.inbox})`
    : sources.claims === 'unavailable' && !['VERIFIED', 'BLOCKED'].includes(classified.state)
      ? 'bus-work-claims/claims.json (unavailable)' : null;
  const state = dependency ? 'BLOCKED' : classified.state;
  const source = `bus-inbox/messages.json + bus-work-claims/claims.json; evidence: ${safe(classified.source)}`;
  const owner = evidence.owner ? safe(evidence.owner) : null;
  const claimReceipt = evidence.claimReceipt ? safe(evidence.claimReceipt) : null;
  let detail = `owner ${owner ?? 'unassigned'}; claim ${claimReceipt ?? 'none'}`;
  if (state === 'BLOCKED') detail = `missing dependency: ${safe(dependency ?? evidence.blocker!.dependency)}`;
  else if (state === 'VERIFIED') {
    const verified = evidence.verified!;
    detail = verified.pr && verified.head ? `PR ${verified.pr}; head ${safe(verified.head)}`
      : verified.tests ? `tests ${safe(verified.tests)}` : `artifact ${safe(verified.artifact!)}`;
  } else if (classified.missing.length) detail += `; missing: ${classified.missing.join(', ')}`;
  const text = `${state} · receipt ${receiptId === null ? 'unavailable' : safe(receiptId)} · as of ${asOf} · source ${source}\n${detail}`;
  return { receiptId, state, owner, claimReceipt, asOf, source, text };
}
