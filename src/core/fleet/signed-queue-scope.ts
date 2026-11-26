import type { EffectiveRepoPolicy } from '../authority/types.js';

// The Mac worktree launcher maps short names to ~/Projects/ashlrai. Keep
// producer and consumer on that namespace until the launcher supports others.
export function signedQueueRepos(policy: { repos: readonly Pick<EffectiveRepoPolicy, 'nameWithOwner' | 'stage'>[] } | null): string[] {
  const repos = (policy?.repos ?? [])
    .filter(({ stage, nameWithOwner }) => (stage === 'propose' || stage === 'merge')
      && /^ashlrai\/[a-z0-9][a-z0-9._-]{0,99}$/iu.test(nameWithOwner))
    .map(({ nameWithOwner }) => nameWithOwner.toLowerCase());
  return [...new Set(repos)].sort();
}
