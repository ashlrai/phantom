/** Wire types for the Leader chat (MASON-INBOX + the leader's replies). Type-only: the web UI imports these. */

/** to-leader: sent (in the inbox), received (the planner picked it up), answered (a reply links to it), open-over-2h (no linked reply after 2 hours). */
export type LeaderChatState = 'sent' | 'received' | 'answered' | 'open-over-2h' | 'reply';

export interface LeaderChatMessage {
  id: string;
  /** ISO instant, or null when the journal time could not be read (shown as unknown). */
  ts: string | null;
  direction: 'to-leader' | 'from-leader';
  channel: string;
  text: string;
  state: LeaderChatState;
  /** to-leader only: the planner acknowledged it (a tick), independent of `state`. */
  received?: boolean;
  /** from-leader only: the message id this reply links to. */
  replyTo?: string;
}

export interface LeaderChat {
  v: 1;
  generatedAt: string;
  /** Oldest first; the newest message is last. */
  messages: LeaderChatMessage[];
  /** Inbox blocks with no readable heading or no text: skipped, never shown. */
  skipped: { malformedInbox: number };
}

export const LEADER_CHAT_OPEN_MS = 2 * 3_600_000;
