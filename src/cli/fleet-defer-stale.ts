import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DeferredDependency {
  id: string;
  dependency: string;
  deferredAt: string;
  state: 'merged' | 'open' | 'missing';
  claimTime: string | null;
}

const usage = 'Usage: ashlr fleet defer-stale [--json]\nReport deferred jobs still in ready.tsv and their dependency state. Read-only.';
const jobId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Report distinct job/dependency pairs, using the latest recorded deferral for each pair. */
export function explainDeferStale(skips: string, ready: string, queue: string, jobs: string): DeferredDependency[] {
  // The dispatcher's ready.tsv has the job ID in the first column.
  const readyIds = new Set(ready.split(/\r?\n/).filter(line => !line.startsWith('#')).map(line => line.split('\t')[0]?.trim()));
  const merged = new Set<string>();
  for (const line of jobs.split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && 'event' in row && row.event === 'outcome' &&
          'state' in row && row.state === 'MERGED' && 'job' in row && typeof row.job === 'string') merged.add(row.job);
    } catch { /* Incomplete or malformed rows are not merge evidence. */ }
  }
  const open = new Map<string, string | null>();
  for (const line of queue.split(/\r?\n/)) {
    const readyMatch = /^- READY (\S+)(?=\s|$)/.exec(line);
    const claimed = /^- CLAIMED (\S+) \S+ (\S+)(?=\s|$)/.exec(line);
    const id = readyMatch?.[1] ?? claimed?.[2];
    if (id && jobId.test(id)) {
      const claimTime = claimed?.[1] ?? null;
      if (!open.has(id) || claimTime !== null) open.set(id, claimTime);
    }
  }
  const rows = new Map<string, DeferredDependency>();
  for (const line of skips.split(/\r?\n/)) {
    const [deferredAt, id, action, reason, ...extra] = line.split('\t');
    const dependency = reason?.startsWith('after_open_') ? reason.slice('after_open_'.length) : '';
    if (extra.length || !deferredAt || !id || !jobId.test(id) || action !== 'defer' || !jobId.test(dependency) || !readyIds.has(id)) continue;
    const state = merged.has(dependency) ? 'merged' : open.has(dependency) ? 'open' : 'missing';
    rows.set(`${id}\t${dependency}`, { id, dependency, deferredAt, state, claimTime: state === 'open' ? open.get(dependency) ?? null : null });
  }
  return [...rows.values()];
}

export async function cmdFleetDeferStale(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const root = process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs');
  try {
    const [skips, ready, queue, jobs] = await Promise.all([
      'queue/skipped-empty.tsv', 'queue/ready.tsv', 'queue/router-queue.md', 'metrics/jobs.jsonl',
    ].map(path => readFile(join(root, path), 'utf8')));
    const rows = explainDeferStale(skips!, ready!, queue!, jobs!);
    if (args[0] === '--json') console.log(JSON.stringify({ schema: 'fleet.defer-stale.v1', readOnly: true, rows }));
    else if (!rows.length) console.log('No deferred jobs remain in the ready queue.');
    else for (const row of rows) console.log(`${row.id}: ${row.dependency} ${row.state}${row.claimTime ? ` (claimed ${row.claimTime})` : ''}; deferred ${row.deferredAt}`);
    return 0;
  } catch {
    console.error('fleet defer-stale: queue or metrics evidence unavailable');
    return 1;
  }
}
