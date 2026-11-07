/** Advisory planning over one repository's PR snapshot; no GitHub operations. */
export interface MergeCandidate {
  number: number;
  files: string[];
  ciMinutes: number;
  dependsOn: number[];
}

export function planMergeBatches(input: unknown) {
  if (!Array.isArray(input)) throw new Error('snapshot must be an array');
  const candidates: MergeCandidate[] = input.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid candidate');
    const row = value as Record<string, unknown>;
    if (!Number.isSafeInteger(row.number) || (row.number as number) <= 0 ||
      !Array.isArray(row.files) || !row.files.length || !row.files.every((f: unknown) => typeof f === 'string' && f.length > 0) ||
      typeof row.ciMinutes !== 'number' || !Number.isFinite(row.ciMinutes) || row.ciMinutes <= 0 ||
      !Array.isArray(row.dependsOn) || !row.dependsOn.every((n: unknown) => Number.isSafeInteger(n) && (n as number) > 0)) {
      throw new Error('invalid candidate');
    }
    return { number: row.number as number, files: [...new Set(row.files as string[])], ciMinutes: row.ciMinutes, dependsOn: [...new Set(row.dependsOn as number[])] };
  });
  const byNumber = new Map(candidates.map(c => [c.number, c]));
  if (byNumber.size !== candidates.length) throw new Error('duplicate PR number');
  const remaining = new Map(byNumber);
  const completed = new Set<number>();
  const batches: { number: number; conflictRisk: number; ciMinutes: number }[][] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(c => c.dependsOn.every(n => completed.has(n)));
    if (!ready.length) break;
    // A shared exact path is a measurable conflict proxy, not proof of a conflict.
    const risk = (c: MergeCandidate) => [...remaining.values()].filter(other => other.number !== c.number && other.files.some(f => c.files.includes(f))).length;
    ready.sort((a, b) => risk(a) - risk(b) || a.ciMinutes - b.ciMinutes || a.number - b.number);
    const files = new Set<string>();
    const batch: { number: number; conflictRisk: number; ciMinutes: number }[] = [];
    for (const candidate of ready) {
      if (candidate.files.some(f => files.has(f))) continue;
      batch.push({ number: candidate.number, conflictRisk: risk(candidate), ciMinutes: candidate.ciMinutes });
      candidate.files.forEach(f => files.add(f));
    }
    batches.push(batch);
    for (const item of batch) { remaining.delete(item.number); completed.add(item.number); }
  }
  const blocked = [...remaining.values()].sort((a, b) => a.number - b.number).map(c => ({
    number: c.number, unresolvedDependencies: c.dependsOn.filter(n => !completed.has(n)).sort((a, b) => a - b),
  }));
  return { schema: 'fleet.merge-batch.v1', batches, blocked };
}
