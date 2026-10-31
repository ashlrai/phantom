/** Pure formatter for the Fleet brief release line. BROWSER-SAFE: no node: imports, no Date.now(). */
export function releaseLine(
  repo: { version: string | null; latestTag: string | null; gh: { latestRelease: { tag: string; publishedAt: string | null } | null } | null },
  nowMs: number,
): string {
  let shipped = '';
  if (repo.gh === null) {
    shipped = 'release status unknown';
  } else if (repo.gh.latestRelease === null) {
    shipped = 'nothing shipped yet';
  } else {
    const lr = repo.gh.latestRelease, tag = lr.tag, publishedAt = lr.publishedAt;
    if (publishedAt === null) { shipped = `${tag} shipped`; }
    else {
      const ts = Date.parse(publishedAt);
      if (Number.isNaN(ts)) { shipped = `${tag} shipped`; }
      else {
        const d = Math.floor((nowMs - ts) / 86_400_000);
        shipped = `${tag} shipped ${d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`}`;
      }
    }
  }
  const tag = repo.latestTag ? repo.latestTag.replace(/^v/, '') : '';
  const version = repo.version;
  let candidate = '';
  if (version !== null) {
    candidate = tag === version ? ' · current' : ` · ${version} candidate`;
  }
  return shipped + candidate;
}
