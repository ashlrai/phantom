/** Read-only release evidence. Publication-time lag is not proof of artifact inclusion. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unreleasedSection } from '../fleet/changelog-fold.js';
import { mapLimited } from '../verse/folder-io.js';
import { opsRunner, type OpsRunner } from '../verse/ops-releases.js';
import { AUTONOMY_REPOS } from './autonomy-audit.js';
import { type ReleaseRow, type ReleasesV1 } from './releases-shape.js';
export type { ReleasesV1 } from './releases-shape.js';

export interface ReadReleasesOptions { repo?: string; root?: string; now?: number; run?: OpsRunner }
export function releaseRepo(name: string): string | null {
  const short = name.replace(/^ashlrai\//, '');
  return AUTONOMY_REPOS.some(repo => repo === short) ? short : null;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const tagName = (v: unknown): v is string => typeof v === 'string' && /^[\w][\w./+-]{0,127}$/.test(v);
const number = (v: string | null): number | null => v !== null && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;

export async function readReleases(opts: ReadReleasesOptions = {}): Promise<ReleasesV1> {
  const filter = opts.repo === undefined ? undefined : releaseRepo(opts.repo);
  if (filter === null) throw new Error('Unknown enrolled repository');
  const now = opts.now ?? Date.now(), root = opts.root ?? join(homedir(), 'Projects', 'ashlrai');
  const run: OpsRunner = async (bin, args) => { try { return await (opts.run ?? opsRunner)(bin, args); } catch { return null; } };
  const json = async (args: string[]): Promise<unknown> => { try { return JSON.parse(await run('gh', args) ?? 'null'); } catch { return null; } };
  const repos = await mapLimited(AUTONOMY_REPOS.filter(repo => !filter || filter === repo), 2, async repo => {
    const row: ReleaseRow = { repo, defaultBranch: null, latestTag: null, ageDays: null, commitsSinceTag: null,
      published: null, drafts: null, releasesKnown: false, mergedPrsSinceRelease: null, freshness: 'unknown',
      reason: 'Release evidence could not be read.', next: 'unknown' };
    const git = (...args: string[]) => run('git', ['-C', join(root, repo), ...args]);
    const remote = await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
    const head = remote?.startsWith('origin/') ? `refs/remotes/${remote}` : null;
    row.defaultBranch = head ? remote!.slice(7) : null;
    if (head) {
      const tag = await git('for-each-ref', `--merged=${head}`, '--sort=-creatordate', '--count=1', '--format=%(refname:strip=2)%09%(creatordate:iso-strict)', 'refs/tags');
      const [name, created] = tag?.split('\t') ?? [];
      if (tagName(name) && date(created)) {
        row.latestTag = name; row.ageDays = Math.max(0, Math.floor((now - Date.parse(created)) / 86_400_000));
        if (await git('rev-parse', '--is-shallow-repository') === 'false') row.commitsSinceTag = number(await git('rev-list', '--count', `refs/tags/${name}..${head}`));
      }
    }
    const releases = await json(['release', 'list', '-R', `ashlrai/${repo}`, '-L', '100', '--json', 'tagName,publishedAt,isDraft,isPrerelease']);
    // A full page might hide an older stable release. Never turn a cap or bad payload into "none".
    if (!Array.isArray(releases) || releases.length >= 100 || !releases.every(r => record(r) && tagName(r.tagName) && typeof r.isDraft === 'boolean'
      && typeof r.isPrerelease === 'boolean' && (r.isDraft || (date(r.publishedAt) && Date.parse(r.publishedAt) <= now)))) return row;
    const detail = (r: Record<string, unknown>) => ({ tag: r.tagName as string, publishedAt: r.isDraft ? null : new Date(r.publishedAt as string).toISOString(), prerelease: r.isPrerelease as boolean });
    row.releasesKnown = true; row.drafts = releases.filter(r => r.isDraft).map(detail);
    const published = releases.filter(r => !r.isDraft && !r.isPrerelease).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
    row.published = published ? detail(published) : null;
    if (!row.published) { row.reason = 'No published stable release establishes a baseline.'; return row; }
    if (!head) { row.reason = 'The default branch is unknown; local origin/HEAD is missing.'; return row; }
    const prs = await json(['pr', 'list', '-R', `ashlrai/${repo}`, '--state', 'merged', '--base', row.defaultBranch!, '--search', `merged:>${row.published.publishedAt}`, '-L', '1000', '--json', 'number,mergedAt']);
    if (!Array.isArray(prs) || prs.length >= 1000 || !prs.every(p => record(p) && Number.isSafeInteger(p.number) && (p.number as number) > 0
      && date(p.mergedAt) && Date.parse(p.mergedAt) > Date.parse(row.published!.publishedAt!) && Date.parse(p.mergedAt) <= now)
      || new Set(prs.map(p => p.number)).size !== prs.length) { row.reason = 'Merged PRs could not be read completely.'; return row; }
    row.mergedPrsSinceRelease = prs.length; row.freshness = prs.length ? 'behind' : 'fresh';
    row.reason = 'Counts PRs merged into the default branch after publication; local refs may be stale.';
    const changelog = await git('show', `${head}:CHANGELOG.md`);
    const section = changelog === null ? null : unreleasedSection(changelog);
    row.next = prs.length === 0 ? 'no new merged PRs' : changelog === null ? 'unknown'
      : section?.split('\n').some(line => /^\s*[-*] \S/.test(line)) ? 'review release' : 'write changelog';
    return row;
  });
  return { schema: 'phantom.releases.v1', version: 1, asOf: new Date(now).toISOString(), repos };
}
