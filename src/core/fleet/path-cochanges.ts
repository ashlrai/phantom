import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBridgeSubject } from './path-job-history.js';

const exec = promisify(execFile);
type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

export function validCochangesPath(path: string): boolean {
  return !!path && ![...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '\\')
    && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}

/** Bounded historical associations are evidence, not dependency or edit authority. */
export async function pathCochanges(path: string, options: { limit?: number; git?: Git } = {}) {
  const limit = options.limit ?? 20;
  if (!validCochangesPath(path) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('invalid path cochanges arguments');
  }
  const run = options.git ?? git;
  const resolvedRef = (await run(['rev-parse', '--verify', 'origin/master^{commit}'])).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedRef)) throw new Error('invalid resolved commit');
  const log = await run(['--literal-pathspecs', 'log', '-n100', '-z', '--format=%H%x00%s', resolvedRef, '--', path]);
  const fields = log.split('\0');
  const matches: Array<{ sha: string; jobId: string }> = [];
  let sampledCount = 0;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i]!;
    if (!sha) continue;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error('invalid git log');
    sampledCount++;
    const bridge = parseBridgeSubject(fields[i + 1]!);
    if (bridge) matches.push({ sha, jobId: bridge.jobId });
  }
  const counts = new Map<string, Array<{ sha: string; jobId: string }>>();
  const selected = matches.slice(0, 20);
  for (const commit of selected) {
    const output = await run(['diff-tree', '--root', '-m', '--first-parent', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit.sha, '--']);
    const paths = new Set(output.split('\0').filter(Boolean));
    if (!paths.has(path)) continue;
    for (const companion of paths) {
      if (companion === path) continue;
      const evidence = counts.get(companion) ?? [];
      evidence.push(commit);
      counts.set(companion, evidence);
    }
  }
  const ranked = [...counts].map(([name, evidence]) => ({ path: name, count: evidence.length, evidence }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    path, resolvedRef, sampledCount, examinedCount: selected.length,
    commitsTruncated: sampledCount === 100, matchesTruncated: matches.length > 20,
    pathsTruncated: ranked.length > limit, omittedPaths: Math.max(0, ranked.length - limit),
    paths: ranked.slice(0, limit),
    notice: 'Cochange evidence does not prove a dependency or authorize edits.',
  };
}
