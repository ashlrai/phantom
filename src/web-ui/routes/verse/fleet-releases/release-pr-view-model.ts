import { formatRelative } from '../autonomy/format.js';
import type { ReleaseCheckState, ReleasePrResult } from '../fleet/release-pr-query.js';

type ReleasePrRow = {
  headline: string; tone: 'ok' | 'warn' | 'danger' | 'neutral';
  checks: { name: string; state: ReleaseCheckState; href: string | null }[];
  href: string | null; notes: string[];
};

export function blockerLine(row: Pick<ReleasePrRow, 'checks' | 'tone'>): string | null {
  if (row.tone !== 'danger' && row.tone !== 'warn') return null;
  const failing = row.checks.filter(check => check.state === 'fail').map(check => check.name);
  const pending = row.checks.filter(check => check.state === 'pending').map(check => check.name);
  return [failing.length ? `Blocked by: ${failing.join(', ')}` : null,
    pending.length ? `Waiting on: ${pending.join(', ')}` : null].filter(Boolean).join(' · ') || null;
}

export function releaseTellPrefill(repo: string, prNumber: number, line: string): string {
  return `Re release PR #${prNumber} (${repo}): ${line}. `;
}

function safeHref(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function releasePrRows(result: ReleasePrResult | undefined, nowMs: number): Map<string, ReleasePrRow | { headline: 'No release PR open'; tone: 'neutral' }> {
  const rows = new Map<string, ReleasePrRow | { headline: 'No release PR open'; tone: 'neutral' }>();
  if (!result || result.kind === 'notInBuild') return rows;
  for (const { repo, pr, notes } of result.data.repos) {
    rows.set(repo.toLowerCase(), pr ? {
      headline: `Release PR #${pr.number} ${pr.title} · ${pr.summary} · open since ${formatRelative(pr.openedAt, nowMs)}`,
      tone: pr.blocked ? 'danger' : pr.pending > 0 ? 'warn' : 'ok',
      href: safeHref(pr.url), notes,
      checks: pr.checks.map(check => ({ name: check.name, state: check.state, href: safeHref(check.url) })),
    } : { headline: 'No release PR open', tone: 'neutral' });
  }
  return rows;
}
