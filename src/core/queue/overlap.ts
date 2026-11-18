import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { nameWithOwnerFromRemote } from '../fleet/repo-identity.js';
import { extractJobPaths } from '../fleet/job-precheck.js';
import { defaultRunsDir } from '../fleet/landed-closes-read.js';
import { parseMergeBatchPrs } from '../fleet/merge-batch.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { ROUTER_LINE, repoKey } from './supersede.js';

export interface QueueOverlapReport {
  schema: 'queue.overlap.v1';
  repo: string | null;
  paths: string[];
  defaultRef: string | null;
  defaultCommit: string | null;
  defaultBranchPaths: string[] | null;
  openPrs: { number: number; paths: string[] }[] | null;
  queued: { id: string; paths: string[] }[] | null;
  gaps: string[];
}
const exec = promisify(execFile);
const sorted = (values: string[]) => [...new Set(values)].sort();
function read(path: string): string | null {
  const result = readStableRegularFile(resolve(path), { anchorPath: dirname(resolve(path)), maxFileBytes: 4 * 1024 * 1024, remainingBytes: 4 * 1024 * 1024 });
  return result.ok ? result.text : null;
}

/** Local evidence only. Existing files and shared paths do not prove a task is done. */
export async function queueOverlap(file: string, { cwd = process.cwd(), runsDir = defaultRunsDir() } = {}): Promise<QueueOverlapReport> {
  const prompt = read(resolve(cwd, file));
  if (prompt === null) throw new Error('Prompt must be a readable regular file of at most 4 MiB.');
  const git = async (...args: string[]): Promise<string | null> => {
    try { return (await exec('git', args, { cwd, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { return null; }
  };
  const paths = extractJobPaths(prompt).sort(), repo = nameWithOwnerFromRemote((await git('remote', 'get-url', 'origin'))?.trim() ?? '')?.toLowerCase() ?? null;
  const wanted = new Set(paths), matches = (files: string[]) => sorted(files.filter(path => wanted.has(path)));
  const gaps: string[] = ['Local snapshots may be stale; exact named files only, not proof of duplicate work.'];
  if (!paths.length) gaps.push('No supported file paths found in the prompt.');
  if (!repo) gaps.push('Repository identity is unavailable; PR and queue comparisons are unknown.');
  const defaultRef = (await git('symbolic-ref', 'refs/remotes/origin/HEAD'))?.trim() || null;
  const defaultCommit = defaultRef ? (await git('rev-parse', '--verify', `${defaultRef}^{commit}`))?.trim() || null : null;
  const tree = defaultCommit ? await git('ls-tree', '--full-tree', '-r', '--name-only', '-z', defaultCommit) : null;
  if (tree === null) gaps.push('Default-branch ref is unavailable (origin/HEAD); no branch was guessed.');
  let openPrs: QueueOverlapReport['openPrs'] = null;
  try {
    const snapshot = parseMergeBatchPrs(JSON.parse(read(join(runsDir, 'fleet/open-prs.json')) ?? 'null'));
    if (repo && snapshot.ok && snapshot.repo?.toLowerCase() === repo && snapshot.upstream === 'ok') {
      openPrs = [];
      if (snapshot.unreadable || snapshot.duplicates) gaps.push('Some PR snapshot rows are unreadable or repeated.');
      for (const pr of snapshot.prs) {
        let files = pr.files;
        if (!pr.filesComplete) {
          const head = (await git('rev-parse', '--verify', `refs/pull/${pr.number}/head^{commit}`))?.trim();
          const diff = defaultCommit && head ? await git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', `${defaultCommit}...${head}`, '--') : null;
          if (diff === null) gaps.push(`PR #${pr.number}: file list is incomplete and local refs are unavailable.`);
          else files = [...files, ...diff.split('\0')];
        }
        const shared = matches(files);
        if (shared.length) openPrs.push({ number: pr.number, paths: shared });
      }
      openPrs.sort((a, b) => a.number - b.number);
    } else gaps.push('Open PR snapshot is missing, invalid, failed or not labeled for this repository.');
  } catch { gaps.push('Open PR snapshot is unreadable.'); }
  const queue = read(join(runsDir, 'queue/router-queue.md'));
  const queued: QueueOverlapReport['queued'] = queue !== null && repo ? [] : null;
  const byId = new Map<string, string[]>();
  for (const line of queued === null ? [] : queue!.split('\n')) {
    if (!/^\s*-\s+(READY|CLAIMED|RUNNING)\b/i.test(line)) continue;
    const row = ROUTER_LINE.exec(line), target = /\brepo\s*=\s*([\w./-]+)/i.exec(row?.[5] ?? '')?.[1];
    if (!row || !target) { gaps.push('Some active queue rows could not be read.'); continue; }
    if (repoKey(target) !== repoKey(repo!) || row[4] === basename(file, '.md')) continue;
    const shared = matches(extractJobPaths(line.slice(row[0].length)));
    if (shared.length) byId.set(row[4]!, sorted([...(byId.get(row[4]!) ?? []), ...shared]));
  }
  for (const id of [...byId.keys()].sort()) queued!.push({ id, paths: byId.get(id)! });
  if (queue === null) gaps.push('Router queue is unavailable.');
  return { schema: 'queue.overlap.v1', repo, paths, defaultRef, defaultCommit,
    defaultBranchPaths: tree === null ? null : matches(tree.split('\0')), openPrs, queued, gaps: sorted(gaps) };
}
