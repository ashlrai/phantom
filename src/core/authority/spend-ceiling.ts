/**
 * ashlr-cost may merge ordinary work. A diff that changes a spend ceiling
 * stays on the owner lane. Path rules for auth, secrets, signing, CI and
 * shell stay high everywhere else.
 */

const SPEND_CEILING_STEMS: ReadonlySet<string> = new Set([
  'spend-ceiling',
  'spend-ceilings',
  'budget-ceiling',
  'budget-ceilings',
  'pricing-ceiling',
  'pricing-ceilings',
  'cost-ceiling',
  'cost-ceilings',
  'metered-usd',
  'max-daily-usd',
]);

function repoName(repo: string): string {
  const slash = repo.lastIndexOf('/');
  return (slash >= 0 ? repo.slice(slash + 1) : repo).toLowerCase();
}

/** True when `repo` is ashlr-cost and `path` is a spend-ceiling file. */
export function isSpendCeilingPath(repo: string, path: string): boolean {
  if (repoName(repo) !== 'ashlr-cost') return false;
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return false;
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  const stem = base.replace(/\.[a-z0-9]+$/u, '');
  return SPEND_CEILING_STEMS.has(stem);
}
