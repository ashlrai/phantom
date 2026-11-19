import { z } from 'zod';

const count = z.number().int().nonnegative().nullable();
const release = z.object({ tag: z.string(), publishedAt: z.string().datetime().nullable(), prerelease: z.boolean() });
const localTag = z.object({ name: z.string().nullable(), ageDays: count, commitsSince: count });

/**
 * GitHub publication facts and local git tag facts live in separate fields on purpose:
 * a local tag is not a publication, and a PR merged after publication is a timing
 * fact, never proof that artifacts include (or exclude) its commits.
 */
export const publicationEvidenceSchema = z.object({
  schema: z.literal('phantom.publication-evidence.v1'), version: z.literal(1), asOf: z.string().datetime(),
  repos: z.array(z.object({
    repo: z.string(), defaultBranch: z.string().nullable(),
    published: release.nullable(), drafts: z.array(release).nullable(), prereleases: z.array(release).nullable(),
    releasesKnown: z.boolean(),
    mergedAfterPublication: count,
    lag: z.enum(['none-merged-after', 'merged-after', 'unknown']),
    reason: z.string(),
    next: z.enum(['no new merged PRs', 'write changelog', 'review release', 'unknown']),
    localTag,
  }).refine(row => row.lag === 'unknown'
    ? row.mergedAfterPublication === null
    : row.releasesKnown && row.published !== null && row.published.publishedAt !== null && !row.published.prerelease
      && row.defaultBranch !== null && row.mergedAfterPublication !== null
      && (row.lag === 'none-merged-after' ? row.mergedAfterPublication === 0 : row.mergedAfterPublication > 0))),
});
export type PublicationEvidenceV1 = z.infer<typeof publicationEvidenceSchema>;
export type PublicationEvidenceRow = PublicationEvidenceV1['repos'][number];
export type PublicationReleaseRef = z.infer<typeof release>;

const tags = (list: PublicationReleaseRef[] | null, label: string, none: string): string =>
  list === null ? `${label} unknown` : list.length ? `${label}: ${list.map(r => r.tag).join(', ')}` : none;

export function publicationEvidenceLine(row: PublicationEvidenceRow): string {
  const lag = row.lag === 'merged-after' ? `${row.mergedAfterPublication} PRs merged after publication`
    : row.lag === 'none-merged-after' ? 'no PRs merged after publication' : 'publication lag unknown';
  const published = row.published ? `Published ${row.published.tag}` : row.releasesKnown ? 'No published stable release' : 'Published release unknown';
  const local = row.localTag;
  return `${row.repo}: ${lag}. ${published}; ${tags(row.drafts, 'Draft', 'no drafts')}; ${tags(row.prereleases, 'Prerelease', 'no prereleases')}.`
    + `${row.lag === 'unknown' ? ` ${row.reason}` : ''} Local tag ${local.name ?? 'unknown'} (${local.ageDays ?? 'unknown'} days old), ${local.commitsSince ?? 'unknown'} commits since. Next: ${row.next}.`;
}
