/** Rate limits and mention-loop suppression. A suppressed wake is still a stored post. */
import {
  FORUM_GLOBAL_WAKES, FORUM_LOOP_EACH_WAY, FORUM_PAIR_WAKES, FORUM_POSTS_PER_WINDOW, FORUM_WINDOW_MS,
  type ForumState, type WakeStatus,
} from './types.js';

export interface WakePlan { target: string; status: WakeStatus }

export function planWakes(state: ForumState, from: string, targets: readonly string[], nowMs: number, exemptPostRate: boolean):
  { ok: true; plans: WakePlan[] } | { ok: false; reason: 'rate-limited' } {
  const posts = state.postTimes.filter((row) => nowMs - row.at < FORUM_WINDOW_MS && row.author === from);
  if (!exemptPostRate && posts.length >= FORUM_POSTS_PER_WINDOW) return { ok: false, reason: 'rate-limited' };
  const sent = state.wakes.filter((row) => row.status === 'sent' && nowMs - row.at < FORUM_WINDOW_MS);
  const plans: WakePlan[] = [];
  for (const target of targets) {
    if (target === from) {
      plans.push({ target, status: 'suppressed-self' });
      continue;
    }
    const forward = sent.filter((row) => row.from === from && row.to === target).length;
    const back = sent.filter((row) => row.from === target && row.to === from).length;
    const pending = plans.filter((plan) => plan.status === 'sent').length;
    if (forward >= FORUM_LOOP_EACH_WAY && back >= FORUM_LOOP_EACH_WAY) plans.push({ target, status: 'suppressed-loop' });
    else if (forward >= FORUM_PAIR_WAKES || sent.length + pending >= FORUM_GLOBAL_WAKES) plans.push({ target, status: 'suppressed-rate' });
    else plans.push({ target, status: 'sent' });
  }
  return { ok: true, plans };
}

export function prune(state: ForumState, nowMs: number): void {
  state.wakes = state.wakes.filter((row) => nowMs - row.at < FORUM_WINDOW_MS).slice(-500);
  state.postTimes = state.postTimes.filter((row) => nowMs - row.at < FORUM_WINDOW_MS).slice(-500);
}
