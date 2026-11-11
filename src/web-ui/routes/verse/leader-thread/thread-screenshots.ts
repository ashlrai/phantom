/**
 * routes/verse/leader-thread/thread-screenshots.ts — split a Leader-thread
 * line into text and screenshot-marker segments. Pure.
 *
 * The composer appends `[screenshot: <abs path>/inbox-attachments/<name>]`
 * (composer-attachment.ts) where <name> is the stored shape —
 * sha256-first-16 + png/jpg/webp (core/verse/leader-attachment-api.ts
 * LEADER_ATTACHMENT_NAME_RE — keep in step). Only that exact marker becomes
 * an image; every other bracket stays plain text for the bubble.
 */
export type ThreadTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'shot'; name: string; raw: string };

const MARKER_RE = /\[screenshot: ([^\]\n]*?\/inbox-attachments\/([0-9a-f]{16}\.(?:png|jpg|webp)))\]/g;

export function splitScreenshotMarkers(text: string): ThreadTextSegment[] {
  const out: ThreadTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER_RE)) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    out.push({ kind: 'shot', name: match[2]!, raw: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
