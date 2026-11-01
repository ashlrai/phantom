import { formatRelative } from '../autonomy/format.js';
import { compareReleaseTags } from '../sections/release-gap-model.js';

export function parseReleaseVersion(text: unknown): [number, number, number] | null {
  if (typeof text !== 'string' || /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.exec(text)?.[0] !== text) return null;
  const [major, minor, patch] = text.split('.').map(Number);
  return [major!, minor!, patch!];
}

export function releaseVersionGuard(
  pr: { number: number; version: string | null; updatedAt: string },
  treeVersion: string | null,
  nowMs: number,
): { verdict: 'match' | 'downgrade' | 'ahead' | 'unknown'; blockMerge: boolean; line: string | null } {
  const state = parseReleaseVersion(pr.version) && parseReleaseVersion(treeVersion)
    ? compareReleaseTags(pr.version!, treeVersion).state : 'unknown';
  const verdict = state === 'behind' ? 'downgrade' : state === 'latest' ? 'match' : state;
  return { verdict, blockMerge: verdict === 'downgrade', line: verdict === 'downgrade'
    ? `Merging #${pr.number} would ship ${pr.version} and set the tree back from ${treeVersion} · release PR last refreshed ${formatRelative(pr.updatedAt, nowMs)} · owner: give release-please the ${treeVersion} version (a Release-As footer or the manifest), then merge`
    : null };
}

export function treeVersionFor(repoEntry: unknown, candidateVersion: string | null): string | null {
  const server = repoEntry !== null && typeof repoEntry === 'object' && 'treeVersion' in repoEntry
    ? repoEntry.treeVersion : null;
  return parseReleaseVersion(server) ? server as string : parseReleaseVersion(candidateVersion) ? candidateVersion : null;
}
