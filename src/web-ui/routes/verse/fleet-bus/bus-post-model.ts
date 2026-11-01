import type { EnvelopeRow } from './agent-bus-model.js';

export type PostStatus = 'posted' | 'duplicate' | 'invalid' | 'conflict' | 'full' | 'unavailable' | 'locked' | 'dispatch-disabled';
export type PostOutcome = { status: PostStatus; cursor?: number };

export const trimPost = (text: string) => text.trim().slice(0, 6000);
export const canPost = (text: string, to: string, sending: boolean) => !!trimPost(text) && !!to && !sending;

// FNV-1a 64-bit, over UTF-8, with a JSON tuple to avoid ambiguous boundaries.
function hashPost(to: string, text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify([to, text]))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function buildMasonEnvelope({ to, text, replyTo, now }: { to: string; text: string; replyTo?: string; now: number }) {
  const trimmed = trimPost(text);
  const dedupeKey = hashPost(to, trimmed);
  return {
    id: `mason-desktop-${dedupeKey.slice(0, 16)}`, from: 'mason', to, priority: 'P0' as const,
    ttl: 7 * 24 * 60 * 60 * 1000,
    body: { kind: 'interjection', channel: 'desktop', text: trimmed, receivedAt: new Date(now).toISOString(), dedupeKey,
      ...(replyTo ? { replyTo } : {}) },
  };
}

export function recentSenders(rows: readonly Pick<EnvelopeRow, 'from'>[]): string[] {
  return [...new Set(rows.map(row => row.from).filter(from => from !== 'mason'))].slice(0, 8);
}

export function postOutcomeText(status: PostStatus, cursor?: number): string {
  switch (status) {
    case 'posted': return cursor === undefined ? 'Posted.' : `Posted · cursor ${cursor}.`;
    case 'duplicate': return 'Already on the bus.';
    case 'invalid': return 'The message was invalid.';
    case 'conflict': return 'A different message already uses this bus ID.';
    case 'full': return 'The bus is full.';
    case 'unavailable': return 'The bus is unavailable.';
    case 'locked': return 'Unlock mutations to post to the bus.';
    case 'dispatch-disabled': return 'This hub was started without --allow-dispatch, so nothing can post.';
  }
}
