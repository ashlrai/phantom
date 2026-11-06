/** Read-only: paths claimed by job prompts still waiting in the fleet queue. No process spawn lives here. */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { extractJobPaths } from './job-precheck.js';

/** `RQ-PHX-<id>.md` — the only queued prompt names that claim paths. */
const QUEUED_NAME = /^RQ-PHX-([A-Z0-9]{3,40})\.md$/;
/** Bound on prompts read per call: the queue is never meant to hold more. */
const MAX_QUEUED_FILES = 400;
/** A real prompt is a few KB; anything larger is not queue evidence. */
const MAX_PROMPT_BYTES = 16 * 1024;

export type QueuedClaimsSourceState = 'healthy' | 'missing' | 'degraded';

export interface QueuedPathClaims {
  sourceState: QueuedClaimsSourceState;
  /** Repo-relative path → sorted queued job ids (basename without `.md`) that name it. */
  claims: Map<string, string[]>;
}

export interface QueuedCollision {
  path: string;
  draft: string;
  queued: string[];
}

export interface ReadQueuedPathClaimsDeps {
  runsRoot?: string;
  readDir?: (dir: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
}

/** Refuse symlink components: no source, including queue evidence, may escape the root. */
async function safeStat(root: string, path: string) {
  let cursor = root;
  let result = await lstat(root);
  if (result.isSymbolicLink()) throw new Error('symlink root');
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    result = await lstat(cursor);
    if (result.isSymbolicLink()) throw new Error('symlink source');
  }
  return result;
}

/** O_NOFOLLOW: even a symlink swapped in after safeStat is never followed. */
async function readPromptFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

const isEnoent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Reads `<runsRoot>/queue/prompts` (ASHLR_RUNS_DIR, default ~/.ashlr-runs).
 * A missing directory is `missing`, never an error — an empty queue is normal.
 * Symlinks, oversize prompts, an oversized listing and per-file read failures
 * degrade the source instead of failing it: partial evidence is still useful
 * to a planner, and the advisory caller decides how much to trust it.
 */
export async function readQueuedPathClaims(
  { runsRoot, readDir, readFile }: ReadQueuedPathClaimsDeps = {},
): Promise<QueuedPathClaims> {
  const root = resolve(runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'));
  const dir = join(root, 'queue/prompts');
  let degraded = false;
  let names: string[];
  try {
    const stat = await safeStat(root, dir);
    if (!stat.isDirectory()) throw new Error('queue/prompts is not a directory');
    names = await (readDir ?? readdir)(dir);
  } catch (error) {
    return { sourceState: isEnoent(error) ? 'missing' : 'degraded', claims: new Map() };
  }
  const queued = names.filter(name => QUEUED_NAME.test(name)).sort();
  if (queued.length > MAX_QUEUED_FILES) {
    queued.length = MAX_QUEUED_FILES;
    degraded = true;
  }
  const byPath = new Map<string, string[]>();
  for (const name of queued) {
    const id = name.slice(0, -'.md'.length);
    const path = join(dir, name);
    try {
      const stat = await safeStat(root, path);
      if (!stat.isFile()) throw new Error('queued prompt is not a file');
      if (stat.size > MAX_PROMPT_BYTES) throw new Error('queued prompt too large');
      const markdown = await (readFile ?? readPromptFile)(path);
      for (const claimed of extractJobPaths(markdown)) {
        let owners = byPath.get(claimed);
        if (!owners) byPath.set(claimed, (owners = []));
        owners.push(id);
      }
    } catch (error) {
      // A prompt deleted mid-scan is a benign race; anything else degrades.
      if (!isEnoent(error)) degraded = true;
    }
  }
  const claims = new Map(
    [...byPath]
      .map(([path, ids]) => [path, [...new Set(ids)].sort()] as [string, string[]])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return { sourceState: degraded ? 'degraded' : 'healthy', claims };
}

/**
 * Draft names carry `.md`; queued ids do not. A queued prompt with the draft's
 * own id is this draft's earlier issue still waiting to be replaced — a
 * re-issue, not a collision. Sorted by path, then draft name.
 */
export function queuedCollisions(
  drafts: ReadonlyArray<{ name: string; paths: ReadonlyArray<string> }>,
  claims: ReadonlyMap<string, ReadonlyArray<string>>,
): QueuedCollision[] {
  const hits: QueuedCollision[] = [];
  for (const draft of drafts) {
    const own = draft.name.replace(/\.md$/, '');
    for (const path of draft.paths) {
      const others = claims.get(path)?.filter(id => id !== own);
      if (others?.length) hits.push({ path, draft: draft.name, queued: others });
    }
  }
  return hits.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.draft < b.draft ? -1 : a.draft > b.draft ? 1 : 0);
}
