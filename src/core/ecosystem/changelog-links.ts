/**
 * Curated cross-repo PR pairs for changes whose PR text omits the relationship.
 * Use owner/repo#number or a full https://github.com/owner/repo/pull/number URL.
 * Only repositories in the collection roster are accepted. Links are symmetric.
 * Example: { from: 'ashlrai/phantom#123', to: 'ashlrai/locus#456' }.
 * Keep this empty until a relationship has been verified; do not infer releases.
 */
export interface EcosystemChangelogLink {
  from: string;
  to: string;
}

export const ECOSYSTEM_CHANGELOG_LINKS: readonly EcosystemChangelogLink[] = [];
