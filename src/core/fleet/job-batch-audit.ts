import { jobCurrentBatch, type JobCurrentBatchReport } from './job-current-batch.js';
import { JOB_BATCH_MAX } from './job-history-batch.js';
import { validJobId } from './job-path-history.js';

type Reader = (ids: string[]) => Promise<JobCurrentBatchReport>;

/** Read-only handoff groups based solely on paths present in bounded evidence. */
export async function jobBatchAudit(ids: string[], read: Reader = jobCurrentBatch) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > JOB_BATCH_MAX
    || new Set(ids).size !== ids.length
    || !ids.every(id => typeof id === 'string' && validJobId(id))) {
    throw new Error('invalid job batch audit arguments');
  }
  const evidence = await read(ids);
  const parents = ids.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) i = parents[i]!;
    return i;
  };
  const paths = new Map<string, number[]>();
  evidence.jobs.forEach((job, i) => {
    for (const path of new Set(job.entries.map(entry => entry.path))) {
      const owners = paths.get(path) ?? [];
      owners.push(i);
      paths.set(path, owners);
      if (owners.length > 1) parents[root(i)] = root(owners[0]!);
    }
  });
  const groups: Array<{ jobs: string[]; sharedPaths: string[] }> = [];
  const components = new Map<number, typeof groups[number]>();
  ids.forEach((id, i) => {
    const key = root(i);
    let group = components.get(key);
    if (!group) { group = { jobs: [], sharedPaths: [] }; components.set(key, group); groups.push(group); }
    group.jobs.push(id);
  });
  for (const [path, owners] of paths) {
    if (owners.length > 1) components.get(root(owners[0]!))!.sharedPaths.push(path);
  }
  return {
    ...evidence,
    jobs: evidence.jobs.map(job => ({ ...job, match: job.commit ? 'matched' as const : 'unknown' as const })),
    groups,
    incomplete: evidence.scanMayBeTruncated || evidence.jobs.some(job => !job.commit || job.matchesTruncated || job.omittedPaths > 0),
  };
}
