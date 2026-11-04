export function parseBridgeSubject(subject: string): { jobId: string; pr: number | null; title: string } | null {
  const match = /^bridge\(([A-Za-z0-9][A-Za-z0-9_-]*)\):\s+(.+)$/.exec(subject);
  if (!match) return null;
  const pr = /\s+\(#(\d+)\)$/.exec(match[2]!);
  return { jobId: match[1]!, pr: pr ? Number(pr[1]) : null,
    title: pr ? match[2]!.slice(0, pr.index) : match[2]! };
}

/** The adapter supplies git log order (newest first), including plain commits. */
export async function pathJobHistory(
  path: string,
  git: { log(path: string, limit: number): Promise<Array<{ sha: string; date: string; subject: string }>> },
  opts?: { limit?: number },
): Promise<Array<{ jobId: string; pr: number | null; sha: string; date: string; title: string }>> {
  const limit = opts?.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer');
  const rows: Array<{ jobId: string; pr: number | null; sha: string; date: string; title: string }> = [];
  const seen = new Set<string>();
  for (const commit of await git.log(path, limit)) {
    const bridge = parseBridgeSubject(commit.subject);
    if (!bridge || seen.has(bridge.jobId)) continue;
    seen.add(bridge.jobId);
    rows.push({ ...bridge, sha: commit.sha, date: commit.date });
    if (rows.length === limit) break;
  }
  return rows;
}
