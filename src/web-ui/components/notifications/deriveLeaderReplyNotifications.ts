import { setHomeChoice } from '../../routes/verse/shell/home-view-store.js';
import type { LabeledLine } from '../../routes/verse/leader-thread/owner-thread-lines.js';
import type { AppNotification } from './types.js';

/** Individual rows shown at once; anything older collapses into one "N more" row. */
export const LEADER_REPLY_CAP = 3;
const BODY_MAX = 140;

export interface LeaderReplyInput {
  /** The Leader pane's merged lines (fleet thread + outbox + owner thread). */
  lines: readonly LabeledLine[];
  /** Epoch ms of the newest line already told or seen; null before the first seed. */
  mark: number | null;
  /** The Leader view is on screen and the window has focus: Mason is reading it. */
  viewing: boolean;
}

/** Newest dated Leader line time, for seeding or advancing the mark. NaN-timed lines are ignored. */
export function newestLeaderLineAt(lines: readonly LabeledLine[]): number | null {
  const times = lines.filter(isLeaderReply).map(line => line.at);
  return times.length ? Math.max(...times) : null;
}

const isLeaderReply = (line: LabeledLine): boolean => line.who === 'leader' && line.source !== 'system' && Number.isFinite(line.at);

/** Markdown to the plain words a banner can show. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[`*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Thread and owner ids are stable; outbox/inbox ids are array positions that shift, so those use time + text. */
function stableId(line: LabeledLine): string {
  return /^(?:outbox|inbox)-\d+$/.test(line.id) ? `leader-reply:${line.at}-${hash(line.text.trim())}` : `leader-reply:${line.id}`;
}

/** One info notification per Leader line newer than the mark, newest three plus a collapsed "N more" row. */
export function deriveLeaderReplyNotifications({ lines, mark, viewing }: LeaderReplyInput, _nowMs: number): AppNotification[] {
  if (mark === null || viewing) return [];
  const seenTexts = new Set<string>();
  const fresh = lines.filter(isLeaderReply).filter(line => line.at > mark).sort((a, b) => b.at - a.at).filter(line => {
    // The same answer can arrive over the thread and the owner channels.
    const key = line.text.trim();
    if (seenTexts.has(key)) return false;
    seenTexts.add(key);
    return true;
  });
  const open = () => setHomeChoice('leader');
  const rows: AppNotification[] = fresh.slice(0, LEADER_REPLY_CAP).map(line => ({
    id: stableId(line), category: 'fleet', severity: 'info', title: 'Leader replied',
    detail: plainText(line.text).slice(0, BODY_MAX), ts: new Date(line.at).toISOString(),
    actionLabel: 'Open Leader', actionRun: open,
  }));
  const rest = fresh.slice(LEADER_REPLY_CAP);
  if (rest.length) rows.push({
    id: 'leader-reply:more', category: 'fleet', severity: 'info', title: `${rest.length} more Leader replies`,
    detail: 'Older replies from the Leader are waiting in the thread.', ts: new Date(rest[0]!.at).toISOString(),
    actionLabel: 'Open Leader', actionRun: open,
  });
  return rows;
}
