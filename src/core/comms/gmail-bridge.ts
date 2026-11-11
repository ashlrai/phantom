/** Local-only Gmail triage. The caller supplies a read-only mailbox adapter;
 * this module never receives credentials and has no provider write operation. */
import { createHash } from 'node:crypto';
import { createDraft, listDrafts } from '../cos/drafts.js';

export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  /** Provider-supplied auto-submitted header; absent means unknown, not "no". */
  autoSubmitted?: string;
}
export type GmailClassification = 'update' | 'reply' | 'review';
export interface GmailBridgeDependencies {
  /** Must be backed by a credential broker restricted to Gmail read methods. */
  readInbox: () => Promise<readonly GmailMessage[]>;
  classify: (message: GmailMessage) => Promise<GmailClassification>;
  composeReply: (message: GmailMessage) => Promise<string>;
  summarizeUpdate: (message: GmailMessage) => Promise<string>;
  runsDir: string;
}
export interface GmailBridgeReport {
  scanned: number;
  updates: string[];
  /** New drafts created during this poll; existing drafts are not counted. */
  drafted: number;
  review: number;
  failed: number;
}

/** One bounded poll. Reports never include provider errors or credentials. */
export async function pollGmailBridge(deps: GmailBridgeDependencies): Promise<GmailBridgeReport> {
  const messages = await deps.readInbox();
  if (messages.length > 100) throw new Error('Gmail inbox batch exceeds 100 messages');
  const report: GmailBridgeReport = { scanned: messages.length, updates: [], drafted: 0, review: 0, failed: 0 };
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message.id || seen.has(message.id)) { report.review++; continue; }
    seen.add(message.id);
    try {
      const classification = await deps.classify(message);
      if (classification === 'update') {
        report.updates.push(await deps.summarizeUpdate(message));
      } else if (classification === 'reply' && message.autoSubmitted?.toLowerCase() === 'no') {
        const source = `gmail-${createHash('sha256').update(message.id).digest('hex').slice(0, 16)}`;
        if ((await listDrafts({ runsDir: deps.runsDir })).some((draft) => draft.source === source)) continue;
        const body = await deps.composeReply(message);
        await createDraft({ to: message.from, subject: `Re: ${message.subject}`, body, source }, deps.runsDir);
        report.drafted++;
      } else {
        report.review++;
      }
    } catch {
      report.failed++;
    }
  }
  return report;
}
