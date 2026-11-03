/** List (and optionally remove) job worktrees whose work already landed or went quiet. */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const USAGE =
  'Usage: ashlr fleet worktree-stale [--root <dir>] [--apply] [--json]\n' +
  'Lists job worktrees under <root> (default ~/Projects/ashlrai/wt) that are safe to clean up: the job has a MERGED outcome row in metrics/jobs.jsonl, or it has no row in the last 72 hours. Oldest first. Dry run unless --apply; --apply runs `git worktree remove` (no --force) only for MERGED ones. guardian-* dirs are never listed or touched. Exits 0 ok, 1 when a removal failed, 2 bad usage.';

const STALE_MS = 72 * 3_600_000;

export type StaleReason = 'merged' | 'no-row';

export interface StaleWorktree {
  job: string;
  path: string;
  reason: StaleReason;
  /** Newest of: last jobs.jsonl row, directory mtime. ISO time. */
  lastActivity: string;
  removed?: boolean;
  error?: string;
}

export interface FleetWorktreeStaleView {
  v: 1;
  generatedAt: string;
  root: string;
  apply: boolean;
  stale: StaleWorktree[];
}

export interface FleetWorktreeStaleFs {
  /** Names of the entries directly under root. */
  listDirs(root: string): Promise<string[]>;
  /** Directory mtime in ms, or null when it is not a directory. */
  mtimeMs(path: string): Promise<number | null>;
}

export interface FleetWorktreeStaleDeps {
  fs?: FleetWorktreeStaleFs;
  /** Raw text of metrics/jobs.jsonl ('' when absent). */
  readJobs?: () => Promise<string>;
  /** Runs `git <argv>`; resolves stdout. Must never use a shell. */
  git?: (argv: string[]) => Promise<string>;
  now?: () => number;
}

const defaultFs: FleetWorktreeStaleFs = {
  async listDirs(root) {
    return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  },
  async mtimeMs(path) {
    const s = await stat(path);
    return s.isDirectory() ? s.mtimeMs : null;
  },
};

const defaultGit = async (argv: string[]): Promise<string> => (await execFileAsync('git', argv, { timeout: 60_000 })).stdout;

function defaultReadJobs(): () => Promise<string> {
  const runs = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  return async () => {
    try { return await readFile(join(runs, 'metrics', 'jobs.jsonl'), 'utf8'); } catch { return ''; }
  };
}

/** Per job: newest row time and whether any outcome row says MERGED. */
function indexJobs(text: string): Map<string, { last: number; merged: boolean }> {
  const jobs = new Map<string, { last: number; merged: boolean }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = r.job ?? r.job_id ?? r.id;
    const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (typeof id !== 'string' || !Number.isFinite(at)) continue;
    const entry = jobs.get(id) ?? { last: 0, merged: false };
    entry.last = Math.max(entry.last, at);
    if (r.event === 'outcome' && String(r.state).toUpperCase() === 'MERGED') entry.merged = true;
    jobs.set(id, entry);
  }
  return jobs;
}

/** Pure-ish core: reads through the injected fs and jobs reader, never runs git. */
export async function findStaleWorktrees(
  root: string,
  deps: Required<Pick<FleetWorktreeStaleDeps, 'fs' | 'readJobs'>> & { now: number },
): Promise<StaleWorktree[]> {
  const jobs = indexJobs(await deps.readJobs());
  const found: Array<StaleWorktree & { at: number }> = [];
  for (const name of await deps.fs.listDirs(root)) {
    if (name.startsWith('guardian-') || name.startsWith('.')) continue;
    const path = join(root, name);
    const mtime = await deps.fs.mtimeMs(path);
    if (mtime === null) continue;
    const row = jobs.get(name);
    const at = Math.max(mtime, row?.last ?? 0);
    // A directory touched inside the window is live even if the ledger has no row yet.
    const reason: StaleReason | null = row?.merged ? 'merged' : deps.now - at > STALE_MS ? 'no-row' : null;
    if (reason) found.push({ job: name, path, reason, lastActivity: new Date(at).toISOString(), at });
  }
  found.sort((a, b) => a.at - b.at || a.job.localeCompare(b.job));
  return found.map(({ at: _at, ...rest }) => rest);
}

export async function cmdFleetWorktreeStale(args: string[], deps: FleetWorktreeStaleDeps = {}): Promise<number> {
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  let root = join(homedir(), 'Projects', 'ashlrai', 'wt');
  let apply = false;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!['--root', '--apply', '--json'].includes(token)) {
      console.error(`error: ${token.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${token}\n${USAGE}`);
      return 2;
    }
    if (seen.has(token)) {
      console.error(`error: duplicate option: ${token}\n${USAGE}`);
      return 2;
    }
    seen.add(token);
    if (token === '--apply') apply = true;
    else if (token === '--json') json = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        console.error(`error: --root needs a directory\n${USAGE}`);
        return 2;
      }
      root = value;
    }
  }
  root = resolve(root);

  const now = (deps.now ?? Date.now)();
  const git = deps.git ?? defaultGit;
  let stale: StaleWorktree[];
  try {
    stale = await findStaleWorktrees(root, { fs: deps.fs ?? defaultFs, readJobs: deps.readJobs ?? defaultReadJobs(), now });
  } catch (error) {
    console.error(`error: cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let failed = false;
  if (apply) {
    for (const item of stale) {
      if (item.reason !== 'merged') continue;
      try {
        // Run from the owning repo, not from inside the worktree being removed.
        const common = (await git(['-C', item.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
        const repo = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : common;
        await git(['-C', repo, 'worktree', 'remove', item.path]);
        item.removed = true;
      } catch (error) {
        item.removed = false;
        item.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
        failed = true;
      }
    }
  }

  const view: FleetWorktreeStaleView = { v: 1, generatedAt: new Date(now).toISOString(), root, apply, stale };
  if (json) {
    process.stdout.write(JSON.stringify(view, null, 2) + '\n');
  } else if (stale.length === 0) {
    console.log(`No stale worktrees under ${root}.`);
  } else {
    console.log(`${stale.length} stale worktree(s) under ${root}${apply ? '' : ' (dry run; add --apply to remove merged ones)'}:`);
    for (const item of stale) {
      const note = item.removed === true ? ' removed' : item.removed === false ? ` FAILED: ${item.error}` : '';
      console.log(`  ${item.job}  ${item.reason}  last ${item.lastActivity}${note}`);
    }
  }
  return failed ? 1 : 0;
}
