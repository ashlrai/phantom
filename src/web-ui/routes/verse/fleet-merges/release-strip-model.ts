import { safeHref } from '../cloud/cloud-model.js';
import type { ReleaseCheck, ReleasePrData, ReleasePrResult } from '../fleet/release-pr-query.js';

export interface ReleaseStripView {
  text: string; tone: 'danger' | 'warning' | 'ok' | 'neutral'; href: string | null;
  failing: string[]; checks: ReleaseCheck[];
}

function relative(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return '—';
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function githubHref(url: string | null): string | null {
  return url?.startsWith('https://github.com/') ? safeHref(url, 'github.com') : null;
}

export function releaseStrip(result: ReleasePrResult | undefined, nowMs: number, repoFilter?: string): ReleaseStripView | null {
  if (!result || result.kind === 'notInBuild') return null;
  const data: ReleasePrData = result.data;
  const repos = repoFilter ? data.repos.filter(repo => repo.repo === repoFilter) : data.repos;
  const pr = (repos.find(repo => repo.repo.endsWith('/phantom') && repo.pr) ?? repos.find(repo => repo.pr))?.pr;
  const suffix = data.sourceState === 'degraded' ? ' · GitHub unreachable, showing the last answer' : '';
  if (!pr) return { text: `No release PR open${suffix}`, tone: 'neutral', href: null, failing: [], checks: [] };
  return {
    text: `${pr.summary} · open since ${relative(pr.openedAt, nowMs)}${suffix}`,
    tone: pr.blocked ? 'danger' : pr.pending > 0 ? 'warning' : 'ok',
    href: githubHref(pr.url), failing: pr.failing,
    checks: pr.checks.map(check => ({ ...check, url: githubHref(check.url) })),
  };
}
