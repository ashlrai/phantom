export type OutboxKind = 'decision' | 'alert' | 'done' | 'fyi';

export const OUTBOX_KIND_LABEL: Record<OutboxKind, string> = {
  decision: 'Needs you', alert: 'Alert', done: 'Done', fyi: 'FYI',
};

/** Classify free-form outbox text in priority order. */
export function classifyOutboxText(text: string): OutboxKind {
  if (/\b(?:needs mason|needs you|your call|approve|confirm|reply with|yes\/no)\b/i.test(text)
    || text.split(/\r?\n/).some(line => /\b(?:mason,|you\b).*\?\s*$/i.test(line))) return 'decision';
  if (/\b(?:down|failed|red|blocked|stuck|out of usage|p0|incident|force quit)\b/i.test(text)) return 'alert';
  if (/\b(?:merged|shipped|released|installed|landed|done|fixed)\b/i.test(text)) return 'done';
  return 'fyi';
}
