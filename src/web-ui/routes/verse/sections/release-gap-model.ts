export interface ReleaseGapView {
  state: 'latest' | 'behind' | 'ahead' | 'unknown';
  installed: string;
  latest: string | null;
}

function versionParts(tag: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i.exec(tag.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareReleaseTags(installed: string, latestTag: string | null): ReleaseGapView {
  const current = versionParts(installed);
  const latest = latestTag === null ? null : versionParts(latestTag);
  if (!current || !latest) return { state: 'unknown', installed, latest: latestTag };
  for (let i = 0; i < 3; i++) {
    if (current[i]! < latest[i]!) return { state: 'behind', installed, latest: latestTag };
    if (current[i]! > latest[i]!) return { state: 'ahead', installed, latest: latestTag };
  }
  return { state: 'latest', installed, latest: latestTag };
}

export function releaseGapText(view: ReleaseGapView): string {
  if (view.state === 'unknown') return 'Release list unavailable';
  if (view.state === 'latest') return 'Installed is the latest release';
  return `Installed ${view.installed} · latest release ${view.latest}`;
}

export function unshippedText(input: { commitsSinceTag: number | null; prNumber: number | null; prBlocked: boolean | null }): string | null {
  if (input.commitsSinceTag === null || input.commitsSinceTag === 0) return null;
  const text = `${input.commitsSinceTag} commits merged since, not yet released`;
  if (input.prNumber === null || input.prBlocked === null) return text;
  return `${text} · release PR #${input.prNumber} ${input.prBlocked ? 'blocked' : 'open'}`;
}

export function releaseNotesUrl(tag: string): string {
  return `https://github.com/ashlrai/phantom/releases/tag/${encodeURIComponent(tag)}`;
}
