/** A validated, bounded projection of the merge planner's read-only snapshot. */
export interface PaletteBacklogItem {
  number: number;
  title: string;
  job: string | null;
  state: string;
  action: 'recut' | 'refresh' | 'wait' | 'merge';
  url: string;
}

const rank: Record<PaletteBacklogItem['action'], number> = { recut: 0, refresh: 1, wait: 2, merge: 3 };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function paletteBacklog(read: unknown): PaletteBacklogItem[] {
  if (!record(read) || read.v !== 1 || read.source !== 'ok' || typeof read.repo !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(read.repo) || !Array.isArray(read.items)) return [];
  const repo = read.repo;
  const result: PaletteBacklogItem[] = [];
  const seen = new Set<number>();
  for (const row of read.items) {
    if (!record(row) || !Number.isSafeInteger(row.number) || (row.number as number) <= 0
      || typeof row.title !== 'string' || typeof row.mergeStateStatus !== 'string' || !row.mergeStateStatus
      || typeof row.isDraft !== 'boolean' || row.isDraft || !(row.job === null || typeof row.job === 'string')
      || typeof row.suggestedAction !== 'string' || !Object.hasOwn(rank, row.suggestedAction)) continue;
    const number = row.number as number;
    if (seen.has(number)) continue;
    seen.add(number);
    result.push({ number, title: row.title, job: row.job as string | null, state: row.mergeStateStatus,
      action: row.suggestedAction as PaletteBacklogItem['action'], url: `https://github.com/${repo}/pull/${number}` });
  }
  return result.sort((a, b) => rank[a.action] - rank[b.action]
    || Number(b.state === 'DIRTY') - Number(a.state === 'DIRTY') || a.number - b.number).slice(0, 20);
}

export function backlogItemTitle(item: PaletteBacklogItem): string {
  return `PR #${item.number} · ${item.state} · ${item.action} · ${item.title}`;
}

export function backlogItemKeywords(item: PaletteBacklogItem): string[] {
  return [String(item.number), item.job ?? '', item.state, item.action, 'dirty', 'stuck', 'backlog'].map(word => word.toLowerCase());
}
