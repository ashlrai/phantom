/**
 * Rebase batch ordering, generator half (recovered from PR #4079,
 * RQ-SWE3-REBASEORDER-1).
 *
 * Convention: PRs whose touched-file sets overlap — transitively, through any
 * shared path — form one cluster. Sibling clusters land in the SAME rebase
 * batch (one session resolves them in order instead of each merge re-dirtying
 * the next); disjoint PRs spread across batches.
 *
 * The generator stamps `cluster=clu-<lowest PR number>` on each REBASE queue
 * line so downstream consumers can identify conflicting siblings. Clustering
 * uses the PR's full touched-file list — a truncated listing can only
 * under-cluster, never wrongly merge.
 */

/** Union-find connected components over shared files. Items with an empty file
 * set are singletons and never merge. Deterministic for a deterministic input
 * order; members keep input order inside each component. */
export function fileClusters<T extends { files: readonly string[] }>(items: readonly T[]): T[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (let i = 0; i < items.length; i += 1) parent.set(i, i);
  const seenFile = new Map<string, number>();
  for (let i = 0; i < items.length; i += 1) {
    for (const file of new Set(items[i]!.files)) {
      if (!file) continue;   // a missing path entry is no overlap evidence
      const other = seenFile.get(file);
      if (other === undefined) { seenFile.set(file, i); continue; }
      const a = find(i);
      const b = find(other);
      if (a !== b) parent.set(b, a);
    }
  }
  const groups = new Map<number, T[]>();
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(items[i]!);
    else groups.set(root, [items[i]!]);
  }
  return [...groups.values()];
}

/** `clu-<lowest id>` — the cluster key stamped on queue lines. */
export function clusterKey(ids: readonly number[]): string {
  return `clu-${Math.min(...ids)}`;
}
