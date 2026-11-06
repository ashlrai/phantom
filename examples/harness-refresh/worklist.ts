import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHarnessDigest } from '../../src/core/learn/harness-digest-reader.js';

type Digest = NonNullable<ReturnType<typeof readHarnessDigest>>;
type Issue = Digest['issues'][number];
type WorkItem = { id: string; urls: string[]; reasons: string[] };

/** Build data for a human or leader to review; never interpret or fetch citations. */
export function refreshWorklist(file: string, now: Date): {
  v: 1;
  asOf: string;
  staleDays: 7;
  worklist: WorkItem[];
  unmatchedIssues: Issue[];
} {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid clock');
  const digest = readHarnessDigest(file, now);
  if (!digest) throw new Error('Unable to read digest as a stable regular file (maximum 1 MiB)');

  const items = new Map<string, WorkItem>();
  for (const source of digest.sources) {
    let item = items.get(source.id);
    if (!item) {
      item = { id: source.id, urls: [], reasons: [] };
      items.set(source.id, item);
    }
    for (const url of source.urls) if (!item.urls.includes(url)) item.urls.push(url);
    if (source.stale === true && !item.reasons.includes('stale')) item.reasons.push('stale');
    if (source.checkedAt === null && !item.reasons.includes('undated')) item.reasons.push('undated');
  }
  const unmatchedIssues: Issue[] = [];
  for (const issue of digest.issues) {
    const item = items.get(issue.id);
    if (!item) unmatchedIssues.push(issue);
    else {
      const reason = `issue:${issue.code}`;
      if (!item.reasons.includes(reason)) item.reasons.push(reason);
    }
  }
  return {
    v: 1,
    asOf: now.toISOString().slice(0, 10),
    staleDays: 7,
    worklist: [...items.values()].filter((item) => item.reasons.length > 0),
    unmatchedIssues,
  };
}

export function runCli(args: string[]): number {
  if (args.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(args[1]!)) {
    process.stderr.write('Usage: tsx examples/harness-refresh/worklist.ts <digest.md> <UTC-date YYYY-MM-DD>\n');
    return 2;
  }
  const now = new Date(`${args[1]}T00:00:00.000Z`);
  if (!Number.isFinite(now.getTime()) || now.toISOString().slice(0, 10) !== args[1]) {
    process.stderr.write('Invalid UTC date\n');
    return 2;
  }
  try {
    process.stdout.write(JSON.stringify(refreshWorklist(args[0]!, now), null, 2) + '\n');
    return 0;
  } catch {
    process.stderr.write('Unable to read digest as a stable regular file (maximum 1 MiB)\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
