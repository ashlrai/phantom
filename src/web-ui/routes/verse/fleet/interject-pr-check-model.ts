/** Client model for GET /api/verse/fleet/control/interject-pr-check: whether
 * GitHub agrees with an order trace that calls an inbox entry merged. */
export type InterjectPrVerdict = 'merged' | 'open' | 'closed-unmerged' | 'unknown';
export interface InterjectPrCheckItem { pr: number; verdict: InterjectPrVerdict; mergedAt: string | null; reason?: string }
export interface InterjectPrCheck { v: 1; authority: 'none'; generatedAt: string; items: InterjectPrCheckItem[] }
export const INTERJECT_PR_CHECK_MAX = 5;

const VERDICTS: readonly string[] = ['merged', 'open', 'closed-unmerged', 'unknown'];

export function interjectPrCheckUrl(prs: readonly number[]): string {
  return `/api/verse/fleet/control/interject-pr-check?${prs.map(pr => `pr=${pr}`).join('&')}`;
}

export function parseInterjectPrCheck(x: unknown): InterjectPrCheck | null {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o['v'] !== 1 || typeof o['generatedAt'] !== 'string' || !Array.isArray(o['items'])) return null;
  const items: InterjectPrCheckItem[] = [];
  for (const raw of o['items']) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r['pr'] !== 'number' || !Number.isSafeInteger(r['pr']) || typeof r['verdict'] !== 'string' || !VERDICTS.includes(r['verdict'])) return null;
    if (r['mergedAt'] !== null && typeof r['mergedAt'] !== 'string') return null;
    items.push({ pr: r['pr'], verdict: r['verdict'] as InterjectPrVerdict, mergedAt: r['mergedAt'] as string | null,
      ...(typeof r['reason'] === 'string' ? { reason: r['reason'] } : {}) });
  }
  return { v: 1, authority: 'none', generatedAt: o['generatedAt'], items };
}

export interface GithubAgreement { label: string; tone: 'ok' | 'warn' | 'neutral'; title: string }

export function githubAgreement(item: InterjectPrCheckItem | undefined): GithubAgreement {
  if (item?.verdict === 'merged') {
    const when = item.mergedAt ? new Date(item.mergedAt) : null;
    const time = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
    return { label: time ? `GitHub: merged ${time}` : 'GitHub: merged', tone: 'ok', title: 'GitHub reports this pull request merged.' };
  }
  if (item?.verdict === 'open') return { label: 'GitHub: still open', tone: 'warn', title: 'The order trace says merged, but GitHub shows the pull request open.' };
  if (item?.verdict === 'closed-unmerged') return { label: 'GitHub: closed unmerged', tone: 'warn', title: 'The order trace says merged, but GitHub shows the pull request closed without merging.' };
  return { label: 'GitHub: unknown', tone: 'neutral', title: 'GitHub could not be read; the order trace is the only evidence.' };
}
