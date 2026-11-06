/**
 * Map a MASON-INBOX source name ("Phantom desktop chat", "Phantom mobile", …)
 * onto the channel slug written in `[src:<channel> id:<id>]` lines, so the
 * planner can acknowledge an entry on the channel it arrived from.
 */
const FALLBACK = 'desktop';

export function inboxChannelSlug(source: string): string {
  const name = String(source ?? '').trim().toLowerCase();
  if (/\b(?:phone|mobile)\b/.test(name)) return 'phone';
  if (/\bdesktop\b/.test(name)) return 'desktop';
  const slug = name.replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return slug || FALLBACK;
}
