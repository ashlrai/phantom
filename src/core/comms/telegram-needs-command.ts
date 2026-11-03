import type { listNeedsMason, resolveNeedsMason } from '../fleet/needs-mason-resolve.js';

const ITEM_ID = /^nm-[0-9a-f]{12}$/;
const LIST_MAX = 10;
const TEXT_CLIP = 100;

export function parseResolveCommand(text: string): { itemId: string; reply?: string } | null {
  const match = /^\s*\/resolve(?:@\w+)?\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(text);
  const itemId = match?.[1];
  if (!itemId || !ITEM_ID.test(itemId)) return null;
  const reply = (match?.[2] ?? '').replace(/\s+/g, ' ').trim();
  return reply ? { itemId, reply } : { itemId };
}

export type NeedsRefusalCode = 'unknown' | 'already-resolved' | 'reply-too-long' | 'invalid';

export type NeedsCommandReply =
  | { status: 'usage' }
  | { status: 'list'; items: { id: string; text: string }[] }
  | { status: 'resolved'; itemId: string }
  | { status: 'refused'; code: NeedsRefusalCode }
  | { status: 'failed'; command: 'needs' | 'resolve' };

const REFUSALS: Record<NeedsRefusalCode, string> = {
  unknown: 'no such needs-you item',
  'already-resolved': 'item is already resolved',
  'reply-too-long': 'reply is too long',
  invalid: 'request was not valid',
};

const clip = (value: string): string => (value.length > TEXT_CLIP ? `${value.slice(0, TEXT_CLIP - 1)}…` : value);

/** Only fixed failure text is exposed; filesystem errors may contain paths. */
export function renderNeedsCommandReply(reply: NeedsCommandReply): string {
  switch (reply.status) {
    case 'usage': return 'Usage: /resolve <nm-id> [reply]';
    case 'list': {
      if (reply.items.length === 0) return 'Nothing needs you.';
      const lines = reply.items.slice(0, LIST_MAX).map(item => `${item.id}: ${clip(item.text)}`);
      if (reply.items.length > LIST_MAX) lines.push(`+${reply.items.length - LIST_MAX} more`);
      return lines.join('\n');
    }
    case 'resolved': return `Resolved ${reply.itemId}.`;
    case 'refused': return `Resolve refused: ${REFUSALS[reply.code]}.`;
    case 'failed': return reply.command === 'needs' ? 'Needs list unavailable.' : 'Resolve failed: needs-you file unavailable.';
  }
}

export interface TelegramNeedsCommandDeps {
  list: typeof listNeedsMason;
  resolve: typeof resolveNeedsMason;
}

export async function runTelegramNeedsCommand(text: string, deps: TelegramNeedsCommandDeps): Promise<NeedsCommandReply> {
  const command = /^\s*\/needs(?:@\w+)?(?:\s|$)/i.test(text) ? 'needs' : 'resolve';
  try {
    if (command === 'needs') return { status: 'list', items: deps.list() };
    const request = parseResolveCommand(text);
    if (!request) return { status: 'usage' };
    const result = deps.resolve(request, { source: 'telegram' });
    if (result.ok) return { status: 'resolved', itemId: result.itemId };
    if (result.code !== 'unavailable') return { status: 'refused', code: result.code };
  } catch {
    // Fall through: the reply never carries the error text.
  }
  return { status: 'failed', command };
}
