import { mergeStallFacts } from '../../routes/verse/shell/merge-stall-facts.js';
import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import type { AppNotification } from './types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Surface a sustained mismatch between publishes and confirmed merges. */
export function deriveMergeStallNotification(data: unknown, nowMs: number): AppNotification[] {
  if (!mergeStallFacts(data, nowMs)) return [];

  const detail = data.publishesLastHour.slice(0, 3).map((publish: unknown) => {
    const job = record(publish) && typeof publish.job === 'string' ? publish.job : 'Unknown job';
    const at = record(publish) && typeof publish.at === 'string' ? Date.parse(publish.at) : NaN;
    const age = Number.isFinite(at) ? `${Math.max(0, Math.floor((nowMs - at) / 60_000))}m ago` : 'age unknown';
    return `${job} (${age})`;
  }).join(' · ');
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  const actionHref = paneLinkUrl('fleet-merges', null, false, base) ?? undefined;
  return [{
    id: `merge-stall:${Math.floor(nowMs / 3_600_000)}`,
    category: 'fleet', severity: 'critical',
    title: `Merge gate stalled: ${data.publishesLastHour.length} published, 0 merged in the last hour`,
    detail, ts: new Date(nowMs).toISOString(), actionLabel: 'Open merges', actionHref,
  }];
}
