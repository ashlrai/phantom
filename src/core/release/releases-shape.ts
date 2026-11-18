import { z } from 'zod';

const count = z.number().int().nonnegative().nullable();
const release = z.object({ tag: z.string(), publishedAt: z.string().datetime().nullable(), prerelease: z.boolean() });
export const releasesSchema = z.object({
  schema: z.literal('phantom.releases.v1'), version: z.literal(1), asOf: z.string().datetime(),
  repos: z.array(z.object({
    repo: z.string(), defaultBranch: z.string().nullable(), latestTag: z.string().nullable(), ageDays: count, commitsSinceTag: count,
    published: release.nullable(), drafts: z.array(release).nullable(), releasesKnown: z.boolean(),
    mergedPrsSinceRelease: count, freshness: z.enum(['fresh', 'behind', 'unknown']), reason: z.string(),
    next: z.enum(['no new merged PRs', 'write changelog', 'review release', 'unknown']),
  }).refine(row => row.freshness === 'unknown' ? row.mergedPrsSinceRelease === null
    : row.releasesKnown && row.published?.publishedAt !== null && row.published !== null && !row.published.prerelease && row.defaultBranch !== null
      && row.mergedPrsSinceRelease !== null && (row.freshness === 'fresh' ? row.mergedPrsSinceRelease === 0 : row.mergedPrsSinceRelease > 0))),
});
export type ReleasesV1 = z.infer<typeof releasesSchema>;
export type ReleaseRow = ReleasesV1['repos'][number];
export function releaseRowLine(row: ReleaseRow): string {
  const freshness = row.freshness === 'behind' ? `behind ${row.mergedPrsSinceRelease} merged PRs` : row.freshness;
  const published = row.published ? `Published ${row.published.tag}${row.published.prerelease ? ' (prerelease)' : ''}` : row.releasesKnown ? 'No published stable release' : 'Published release unknown';
  const drafts = row.drafts === null ? 'drafts unknown' : row.drafts.length ? `Draft: ${row.drafts.map(r => r.tag).join(', ')}` : 'no drafts';
  return `${row.repo}: ${freshness}. ${published}; ${drafts}.${row.freshness === 'unknown' ? ` ${row.reason}` : ''} Local tag ${row.latestTag ?? 'unknown'} (${row.ageDays ?? 'unknown'} days old), ${row.commitsSinceTag ?? 'unknown'} commits since. Next: ${row.next}.`;
}
