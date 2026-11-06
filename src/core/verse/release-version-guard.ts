/**
 * Release-version guard for the one-tap release merge. A release-please PR
 * can fall behind the tree version (release-please refreshes on CI time, not
 * on every push); merging it would ship a downgrade the self-update logic
 * then cannot reconcile. Pure helpers: the GET reports the verdict and the
 * POST demands confirmVersion before mergeReleasePr runs.
 */

const RELEASE_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export type ReleaseVersionTriple = [number, number, number];

/** Strict `x.y.z` only — "v3.30.0", ranges and partial versions are null. */
export function parseReleaseVersion(text: unknown): ReleaseVersionTriple | null {
  if (typeof text !== 'string') return null;
  const match = RELEASE_VERSION.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareReleaseVersions(a: ReleaseVersionTriple, b: ReleaseVersionTriple): -1 | 0 | 1 {
  for (const index of [0, 1, 2] as const) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export type ReleaseVersionVerdict = 'match' | 'downgrade' | 'ahead' | 'unknown';

/** pr < tree is 'downgrade', pr > tree is 'ahead', either side unparsable is 'unknown'. */
export function releaseVersionVerdict(prVersion: string | null, treeVersion: string | null): ReleaseVersionVerdict {
  const pr = parseReleaseVersion(prVersion);
  const tree = parseReleaseVersion(treeVersion);
  if (pr === null || tree === null) return 'unknown';
  const order = compareReleaseVersions(pr, tree);
  return order === 0 ? 'match' : order < 0 ? 'downgrade' : 'ahead';
}

/** The top-level "version" of a package.json text; null on any parse problem or non-semver value. */
export function treeVersionFromPackageJson(text: string | null): string | null {
  if (typeof text !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === 'string' && parseReleaseVersion(version) !== null ? version : null;
  } catch { return null; }
}

/** One line for the repos[] notes, the 409 body and the reader surfaces. */
export function releaseVersionLine(
  prNumber: number,
  prVersion: string | null,
  treeVersion: string | null,
  verdict: ReleaseVersionVerdict,
): string {
  const pr = prVersion ?? 'an unparsable version';
  const tree = treeVersion ?? 'an unparsable tree version';
  switch (verdict) {
    case 'downgrade':
      return `Release PR #${prNumber} would ship ${pr} but the tree targets ${tree}; fix release-please's version (a Release-As footer or the manifest) or merge with confirmVersion.`;
    case 'ahead':
      return `Release PR #${prNumber} ships ${pr}, ahead of the tree's ${tree}.`;
    case 'match':
      return `Release PR #${prNumber} ships ${pr}, matching the tree version.`;
    case 'unknown':
      return `Release PR #${prNumber} could not be compared with the tree version.`;
  }
}
