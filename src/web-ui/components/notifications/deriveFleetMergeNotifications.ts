import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import type { AppNotification } from './types.js';

type Merge = { repo: string; number: number; title: string };
type MergeSnapshot = {
  generatedAt: string;
  sources: { merges: 'healthy' | 'degraded' };
  mergesLastHour: { count: number | null; items: Merge[] };
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const clamp = (title: string) => title.length > 120 ? `${title.slice(0, 119)}…` : title;

export function releaseOfTitle(title: string): string | null {
  const match = /^(?:chore\((?:master|main)\): release |release v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(title);
  return match && match[0] === title ? match[1] ?? null : null;
}

function isMergeSnapshot(value: unknown): value is MergeSnapshot {
  if (!record(value) || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || !record(value.sources) || (value.sources.merges !== 'healthy' && value.sources.merges !== 'degraded')
    || !record(value.mergesLastHour) || !(value.mergesLastHour.count === null || natural(value.mergesLastHour.count))
    || !Array.isArray(value.mergesLastHour.items)) return false;
  return value.mergesLastHour.items.every((item: unknown) => record(item)
    && typeof item.repo === 'string' && item.repo.trim().length > 0
    && natural(item.number) && item.number > 0 && typeof item.title === 'string');
}

/** Project the public merge summary into stable, category-mutable notifications. */
export function deriveFleetMergeNotifications(data: unknown, _now: number): AppNotification[] {
  if (!isMergeSnapshot(data)) return [];
  const { items, count } = data.mergesLastHour;
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  const actionHref = paneLinkUrl('fleet-merges', null, false, base) ?? undefined;
  const common = { category: 'fleet' as const, severity: 'info' as const, ts: data.generatedAt,
    actionLabel: 'Open merges', actionHref };
  const releases: AppNotification[] = [];
  const remaining: Merge[] = [];
  for (const item of items) {
    const version = releaseOfTitle(item.title);
    if (version === null) {
      remaining.push(item);
    } else {
      releases.push({ ...common, severity: 'high', id: `fleet-release:${item.repo}:${version}`,
        title: `${item.repo.split('/').at(-1)} ${version} shipped`,
        detail: `Release PR #${item.number} merged. The desktop app can update from Settings ▸ Desktop ▸ Updates.` });
    }
  }
  if (remaining.length > 5) {
    const hour = new Date(data.generatedAt).toISOString().slice(0, 13);
    return [...releases, { ...common, id: `fleet-merge:rollup:${hour}`,
      title: `${count === null ? remaining.length : Math.max(0, count - releases.length)} PRs merged in the last hour`,
      detail: remaining.slice(0, 3).map((item) => clamp(item.title)).join(' · ') }];
  }
  return [...releases, ...remaining.map((item) => ({ ...common, id: `fleet-merge:${item.repo}#${item.number}`,
    title: `Merged #${item.number}`, detail: `${item.repo.split('/').at(-1)}: ${clamp(item.title)}` }))];
}
