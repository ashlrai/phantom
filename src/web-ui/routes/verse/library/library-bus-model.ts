/**
 * routes/verse/library/library-bus-model.ts: pure helpers that turn the
 * agent bus page into the short lines the Library shows. All text is
 * untrusted; the pane renders it as plain text only.
 */
import type { AgentBusPage, AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';

export const BUS_LINE_MAX_CHARS = 160;

export interface LibraryBusLine {
  id: string;
  from: string;
  to: string;
  priority: AgentBusReceipt['envelope']['priority'];
  text: string;
  age: string;
}

function cut(text: string): string {
  return text.length > BUS_LINE_MAX_CHARS ? `${text.slice(0, BUS_LINE_MAX_CHARS - 1)}…` : text;
}

export function busBodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    for (const key of ['text', 'message', 'summary']) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return (JSON.stringify(body) ?? '').slice(0, BUS_LINE_MAX_CHARS);
}

export function busAge(receivedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - receivedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The page's ttl is what remained when it was fetched; the expiry check needs
 * the ttl from receipt, so add back the time already spent (as the bus rail does).
 */
export function withReceiptTtl(page: AgentBusPage, fetchedAt: number): AgentBusPage {
  return { ...page, messages: page.messages.map((row) => ({ ...row, envelope: { ...row.envelope,
    ttl: Math.min(Number.MAX_SAFE_INTEGER, row.envelope.ttl + Math.max(0, fetchedAt - row.receivedAt)) } })) };
}

/** Newest messages first (by cursor), expired ones dropped, at most `limit`. */
export function libraryBusLines(page: AgentBusPage | null, now: number, limit = 8): LibraryBusLine[] {
  if (!page) return [];
  return [...page.messages]
    .sort((a, b) => b.cursor - a.cursor)
    .filter((row) => row.receivedAt + row.envelope.ttl >= now)
    .slice(0, Math.max(0, limit))
    .map(({ receivedAt, envelope }) => {
      const first = busBodyText(envelope.body).split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
      return { id: envelope.id, from: envelope.from, to: envelope.to, priority: envelope.priority, text: cut(first.trim()), age: busAge(receivedAt, now) };
    });
}
