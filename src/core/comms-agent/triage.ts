/**
 * Inbox triage for the Comms role. Classification is label and identity
 * based. Bulk and bot mail is archived. Nothing is deleted.
 */
import { scrubSecrets } from '../util/scrub.js';
import { isCommsTransport, type CommsTransport } from './policy.js';

export type MailClass = 'owner' | 'person' | 'bulk' | 'bot' | 'unknown';

export interface InboxMessage {
  id: string;
  transport: CommsTransport;
  from: string;
  subject: string;
  body: string;
  labels?: readonly string[];
}

export interface ReplyDraft {
  messageId: string;
  transport: CommsTransport;
  recipient: string;
  subject: string;
  body: string;
}

export interface TriageSummary {
  id: string;
  class: MailClass;
  summary: string;
}

export interface TriageResult {
  kept: InboxMessage[];
  archived: InboxMessage[];
  drafts: ReplyDraft[];
  summaries: TriageSummary[];
  /** Always zero. Archive keeps the message; this role has no delete path. */
  deleted: 0;
}

const BULK = new Set(['bulk', 'newsletter', 'list-unsubscribe']);
const BOT = new Set(['bot', 'automated']);

export function classifyMessage(message: InboxMessage, ownerIds: readonly string[]): MailClass {
  const labels = (message.labels ?? []).map(label => label.toLowerCase());
  if (labels.some(label => BULK.has(label))) return 'bulk';
  if (labels.some(label => BOT.has(label))) return 'bot';
  if (message.from.trim() && ownerIds.includes(message.from.trim())) return 'owner';
  if (message.from.trim()) return 'person';
  return 'unknown';
}

export function summarizeMessage(message: InboxMessage, mailClass: MailClass): string {
  const text = `${mailClass}: ${message.subject}`.replace(/\s+/g, ' ').trim().slice(0, 160);
  return scrubSecrets(text) === text ? text : `${mailClass}: [redacted]`;
}

export function triageInbox(messages: readonly InboxMessage[], ownerIds: readonly string[]): TriageResult {
  const kept: InboxMessage[] = [];
  const archived: InboxMessage[] = [];
  const drafts: ReplyDraft[] = [];
  const summaries: TriageSummary[] = [];
  for (const message of messages) {
    const mailClass = classifyMessage(message, ownerIds);
    const summary = summarizeMessage(message, mailClass);
    summaries.push({ id: message.id, class: mailClass, summary });
    switch (mailClass) {
      case 'bulk':
      case 'bot':
        archived.push(message);
        break;
      case 'person':
      case 'owner':
        kept.push(message);
        drafts.push({
          messageId: message.id,
          transport: message.transport,
          recipient: message.from.trim(),
          subject: `Re: ${message.subject}`.replace(/\s+/g, ' ').trim().slice(0, 300),
          body: `Draft reply.\n\n${summary}`,
        });
        break;
      case 'unknown':
        kept.push(message);
        break;
      default: {
        const unexpected: never = mailClass;
        throw new Error(`Unhandled mail class ${String(unexpected)}`);
      }
    }
  }
  return { kept, archived, drafts, summaries, deleted: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export interface ParsedInbox {
  messages: InboxMessage[];
  /** Original rows, including fields triage does not use. */
  rows: Record<string, unknown>[];
}

/** Strict inbox document. A bad document is refused so a run cannot rewrite it. */
export function parseInboxDocument(value: unknown): ParsedInbox | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const messages: InboxMessage[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const row of value.messages) {
    if (!isRecord(row) || !bounded(row.id, 128) || !row.id.trim()) return null;
    if (typeof row.transport !== 'string' || !isCommsTransport(row.transport)) return null;
    if (!bounded(row.from, 256) || !bounded(row.subject, 300) || typeof row.body !== 'string' || row.body.length > 64 * 1024) return null;
    let labels: string[] | undefined;
    if (row.labels !== undefined) {
      if (!Array.isArray(row.labels) || row.labels.length > 16 || row.labels.some(label => !bounded(label, 64))) return null;
      labels = row.labels;
    }
    messages.push({
      id: row.id.trim(),
      transport: row.transport,
      from: row.from,
      subject: row.subject,
      body: row.body,
      ...(labels ? { labels } : {}),
    });
    rows.push({ ...row });
  }
  return { messages, rows };
}
