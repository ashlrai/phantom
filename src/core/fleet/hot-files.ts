import { normalizeRepoPath } from '../authority/protected-paths.js';

export interface HotFile {
  path: string;
  /** Number of distinct open PRs touching the path. */
  count: number;
}

/** Pure, per-repository hot spots: count each path once per PR, then rank by count and path. */
export function findHotFiles(openPrFiles: readonly (readonly string[])[]): HotFile[] {
  const counts = new Map<string, number>();
  for (const files of openPrFiles) {
    const paths = new Set(files.map(normalizeRepoPath).filter((path): path is string => path !== null));
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= 3)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 10);
}
