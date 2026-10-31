import type { OpsRepoReleaseV1, OpsReleasesV1 } from '../../../../core/verse/ops-types.js';

type GitHub = NonNullable<OpsRepoReleaseV1['gh']>;
type Release = NonNullable<GitHub['latestRelease']>;
type Run = NonNullable<GitHub['latestRun']>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

function isRelease(value: unknown): boolean {
  return value === null || (record(value) && typeof value.tag === 'string' && nullableString(value.name)
    && nullableString(value.publishedAt) && typeof value.draft === 'boolean' && typeof value.prerelease === 'boolean');
}

function isRun(value: unknown): boolean {
  return value === null || (record(value) && typeof value.workflow === 'string' && typeof value.status === 'string'
    && nullableString(value.conclusion) && nullableString(value.at));
}

function isRepo(value: unknown): boolean {
  if (!record(value) || typeof value.repo !== 'string' || typeof value.path !== 'string'
    || !nullableString(value.version) || !nullableString(value.latestTag) || !nullableString(value.releaseWorkflow)
    || !(value.commitsSinceTag === undefined || value.commitsSinceTag === null
      || (typeof value.commitsSinceTag === 'number' && Number.isSafeInteger(value.commitsSinceTag) && value.commitsSinceTag >= 0))
    || !Array.isArray(value.notes) || !value.notes.every(note => typeof note === 'string')) return false;
  return value.gh === null || (record(value.gh) && isRelease(value.gh.latestRelease) && isRun(value.gh.latestRun));
}

export function isOpsReleases(value: unknown): value is OpsReleasesV1 {
  return record(value) && value.v === 1 && typeof value.generatedAt === 'string'
    && (value.sourceState === 'healthy' || value.sourceState === 'degraded')
    && Array.isArray(value.repos) && value.repos.every(isRepo);
}

export function orderRepos(repos: readonly OpsRepoReleaseV1[]): OpsRepoReleaseV1[] {
  const phantom = (repo: string) => repo === 'phantom' || repo.endsWith('/phantom');
  return [...repos].sort((a, b) => (b.commitsSinceTag ?? -1) - (a.commitsSinceTag ?? -1)
    || Number(phantom(b.repo)) - Number(phantom(a.repo)) || a.repo.localeCompare(b.repo));
}

export function runTone(run: Run): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (run.status === 'in_progress' || run.status === 'queued') return 'neutral';
  const result = run.conclusion ?? run.status;
  if (result === 'success') return 'ok';
  if (result === 'failure' || result === 'cancelled' || result === 'timed_out') return 'danger';
  return 'warn';
}

export function releaseLabel(release: Release): { label: string; badge: 'draft' | 'prerelease' | null } {
  return { label: `${release.tag}${release.name && release.name !== release.tag ? ` · ${release.name}` : ''}`,
    badge: release.draft ? 'draft' : release.prerelease ? 'prerelease' : null };
}

export function safeRepoHref(repo: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) return null;
  return `https://github.com/${repo}/releases`;
}
