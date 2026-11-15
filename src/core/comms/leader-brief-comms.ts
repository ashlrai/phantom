/**
 * The Comms line of the Leader's brief (RQ-PHX-BRIEFCOMMSLINE47): Dot texts
 * waiting, drafts awaiting Mason, Gmail inboxes over target, Needs-you items,
 * and a blocker when a Dot (Ashlr.) text has waited too long.
 *
 * Pure over a UnifiedInbox. Only counts and ages reach the output; text and
 * mail bodies are untrusted and never copied. Sources are iterated
 * generically so a new source key never breaks the brief.
 */

import type { UnifiedInbox, UnifiedInboxItem } from './unified-inbox.js';

export interface CommsBriefFacts {
  line: string | null;
  blocker: string | null;
}

export const DOT_OVERDUE_MINUTES = 15;

function formatAge(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60 > 0 ? `${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Minutes a teammate item has waited: from `since`, else its `waiting <n>m` detail. */
function waitedMinutes(item: UnifiedInboxItem, nowMs: number): number | null {
  const since = item.since ? Date.parse(item.since) : Number.NaN;
  if (Number.isFinite(since)) return Math.max(0, (nowMs - since) / 60_000);
  const m = /waiting (\d+)m/.exec(item.detail ?? '');
  return m ? Number(m[1]) : null;
}

/** `<inbox> <unread>/<target> unread` from a gmail-over-target item; counts only. */
function gmailPart(item: UnifiedInboxItem): string | null {
  const m = /^([\w.+@-]{1,80}): (\d+) unread, target (\d+)$/.exec(item.title);
  return m ? `${m[1]} ${m[2]}/${m[3]} unread` : null;
}

export function commsBriefFacts(inbox: UnifiedInbox, opts: { overdueMinutes?: number } = {}): CommsBriefFacts {
  const overdue = opts.overdueMinutes ?? DOT_OVERDUE_MINUTES;
  const generated = Date.parse(inbox.generatedAt);
  const nowMs = Number.isFinite(generated) ? generated : Date.now();
  const parts: string[] = [];
  const unreadable: string[] = [];
  let blocker: string | null = null;

  for (const [name, report] of Object.entries(inbox.sources)) {
    if (report.state === 'degraded' || report.state === 'unavailable') {
      unreadable.push(`${name} unreadable`);
      continue;
    }
    if (!(report.pending > 0)) continue;
    const items = inbox.items.filter((i) => i.source === (name as UnifiedInboxItem['source']));
    if (name === 'imessage') {
      const ages = items.map((i) => waitedMinutes(i, nowMs)).filter((a): a is number => a !== null);
      const oldest = ages.length > 0 ? Math.max(...ages) : null;
      parts.push(`${plural(report.pending, 'Dot text')} waiting${oldest !== null ? ` (oldest ${formatAge(oldest)})` : ''}`);
      if (oldest !== null && oldest > overdue) {
        blocker = `Dot (Ashlr.) waiting ${formatAge(oldest)} on ${plural(report.pending, 'text')}`;
      }
    } else if (name === 'drafts') {
      parts.push(`${plural(report.pending, 'draft')} to approve`);
    } else if (name === 'gmail') {
      const named = items.map(gmailPart).filter((p): p is string => p !== null);
      parts.push(named.length > 0 ? named.join(', ') : `${plural(report.pending, 'inbox', 'inboxes')} over target`);
    } else if (name === 'needs-you') {
      parts.push(`${report.pending} Needs-you`);
    }
    // Other sources (bus, linkedin, …) are not part of Mason's comms line.
  }

  const all = [...parts, ...unreadable];
  return { line: all.length > 0 ? `Comms: ${all.join(', ')}` : null, blocker };
}
