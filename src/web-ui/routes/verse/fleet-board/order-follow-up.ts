/**
 * routes/verse/fleet-board/order-follow-up.ts — pure helpers for the "Follow up"
 * button on stuck rows of the "Your orders" strip.
 *
 * The prefill names the order as `<Mon> <D> <HH:MM>`, the same shape the
 * planner's order-citation parser reads from a job's "Serves Mason's …" line,
 * so a follow-up in MASON-INBOX.md links to the order instead of becoming a new
 * request. Rows carry no order body, owner job id or URL, so none can leak here.
 */
import type { OrderRow } from './order-state-model.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const KEY = /^(\d{2})-(\d{2}) ([0-2]\d):([0-5]\d)$/;
export const FOLLOW_UP_MAX = 300;

export function orderFollowUpEligible(row: OrderRow): boolean {
  return row.state === 'RECEIVED' || row.state === 'ASSIGNED' || row.state === 'BLOCKED';
}

/** `Nov 13 13:13` from `11-13 13:13`; null when the key is not a real date/time. */
export function orderFollowUpWhen(key: string): string | null {
  const m = KEY.exec(key);
  if (m === null) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || Number(m[3]) > 23) return null;
  return `${MONTHS[month - 1]} ${day} ${m[3]}:${m[4]}`;
}

export function orderFollowUpPrefill(row: OrderRow): string | null {
  const when = orderFollowUpWhen(row.key);
  if (when === null) return null;
  const head = `Follow-up on my ${when} order (${row.state}`;
  const tail = '): ';
  if (row.missing.length === 0) return head + tail;
  const prefix = `${head}; missing: `;
  const room = FOLLOW_UP_MAX - prefix.length - tail.length;
  return prefix + row.missing.join(', ').slice(0, Math.max(0, room)) + tail;
}
