/** Identify open PRs named in the prompt of a merged fleet job. */
export interface OpenFleetPr {
  number: number;
  title: string;
  mergeStateStatus: string;
}

export interface MergedFleetPr {
  number: number;
  title: string;
}

export interface SupersededPr {
  pr: OpenFleetPr;
  supersededBy: MergedFleetPr;
  evidence: { jobId: string; reference: string };
}

export function findSupersededPrs(
  openPrs: readonly OpenFleetPr[],
  mergedPrs: readonly MergedFleetPr[],
  prompts: ReadonlyMap<string, string>,
): SupersededPr[] {
  const openByNumber = new Map(openPrs.map(pr => [pr.number, pr]));
  const found = new Map<number, SupersededPr>();
  for (const merged of mergedPrs) {
    // A title with multiple job IDs does not identify which prompt produced it.
    const ids = [...new Set(merged.title.match(/\bRQ-[A-Za-z0-9_-]+/g) ?? [])];
    if (ids.length !== 1) continue;
    const jobId = ids[0]!;
    const prompt = prompts.get(jobId);
    if (prompt === undefined) continue;
    for (const match of prompt.matchAll(/\bPR #(\d+)(?![\w])/g)) {
      const pr = openByNumber.get(Number(match[1]));
      if (pr && pr.number !== merged.number && !found.has(pr.number)) {
        found.set(pr.number, { pr, supersededBy: merged, evidence: { jobId, reference: match[0] } });
      }
    }
  }
  return openPrs.flatMap(pr => found.has(pr.number) ? [found.get(pr.number)!] : []);
}
