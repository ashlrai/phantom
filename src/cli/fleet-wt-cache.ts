/** Find (and optionally remove) rebuildable caches inside idle job worktrees. */
import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const USAGE =
  'Usage: ashlr fleet wt-cache [--root <dir>] [--apply] [--json]\n' +
  'Finds node_modules, target and .next dirs directly inside each job dir under <root> (default ~/Projects/ashlrai/wt) that have not changed for 2 hours, and prints one line per kind with count and GB, then "free: N GB". Dry run unless --apply; --apply deletes only those cache dirs, never source. guardian-* dirs are never touched. Exits 0 ok, 1 when a removal failed, 2 bad usage.';

const IDLE_MS = 2 * 3_600_000;
const GB = 1024 ** 3;

export const CACHE_KINDS = ['node_modules', 'target', '.next'] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];

export interface WtCache {
  job: string;
  kind: CacheKind;
  path: string;
  bytes: number;
  removed?: boolean;
  error?: string;
}

export interface FleetWtCacheView {
  v: 1;
  generatedAt: string;
  root: string;
  apply: boolean;
  caches: WtCache[];
  kinds: Array<{ kind: CacheKind; count: number; gb: number }>;
  freeGb: number;
}

export interface FleetWtCacheFs {
  /** Names of the real directories directly under dir (symlinks excluded). */
  listDirs(dir: string): Promise<string[]>;
  /** Directory mtime in ms, or null when it is not a directory. */
  mtimeMs(path: string): Promise<number | null>;
}

export interface FleetWtCacheDeps {
  fs?: FleetWtCacheFs;
  /** Disk usage of a path in bytes. Must never use a shell. */
  du?: (path: string) => Promise<number>;
  /** Recursively deletes one cache dir. */
  remove?: (path: string) => Promise<void>;
  now?: () => number;
}

const defaultFs: FleetWtCacheFs = {
  async listDirs(dir) {
    return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  },
  async mtimeMs(path) {
    const s = await stat(path);
    return s.isDirectory() ? s.mtimeMs : null;
  },
};

const defaultDu = async (path: string): Promise<number> => {
  const { stdout } = await execFileAsync('du', ['-sk', path], { timeout: 120_000 });
  const kb = Number.parseInt(stdout, 10);
  if (!Number.isFinite(kb)) throw new Error(`unreadable du output for ${path}`);
  return kb * 1024;
};

const defaultRemove = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

const gbOf = (bytes: number): number => Math.round((bytes / GB) * 10) / 10;

/** Reads only: lists idle caches and sizes them through the injected du. */
export async function findWtCaches(
  root: string,
  deps: Required<Pick<FleetWtCacheDeps, 'fs' | 'du'>> & { now: number },
): Promise<WtCache[]> {
  const found: WtCache[] = [];
  for (const job of (await deps.fs.listDirs(root)).sort()) {
    if (job.startsWith('guardian-') || job.startsWith('.')) continue;
    const jobDir = join(root, job);
    const inside = new Set(await deps.fs.listDirs(jobDir).catch(() => []));
    for (const kind of CACHE_KINDS) {
      if (!inside.has(kind)) continue;
      const path = join(jobDir, kind);
      const mtime = await deps.fs.mtimeMs(path).catch(() => null);
      if (mtime === null || deps.now - mtime < IDLE_MS) continue;
      found.push({ job, kind, path, bytes: await deps.du(path).catch(() => 0) });
    }
  }
  return found;
}

export async function cmdFleetWtCache(args: string[], deps: FleetWtCacheDeps = {}): Promise<number> {
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
  let caches: WtCache[];
  try {
    caches = await findWtCaches(root, { fs: deps.fs ?? defaultFs, du: deps.du ?? defaultDu, now });
  } catch (error) {
    console.error(`error: cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let failed = false;
  if (apply) {
    const remove = deps.remove ?? defaultRemove;
    for (const item of caches) {
      try {
        await remove(item.path);
        item.removed = true;
      } catch (error) {
        item.removed = false;
        item.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
        failed = true;
      }
    }
  }

  // Only caches that are (or would be) gone count as freed.
  const kinds = CACHE_KINDS.map(kind => {
    const rows = caches.filter(c => c.kind === kind && c.removed !== false);
    return { kind, count: rows.length, gb: gbOf(rows.reduce((sum, c) => sum + c.bytes, 0)) };
  });
  const freeGb = gbOf(caches.filter(c => c.removed !== false).reduce((sum, c) => sum + c.bytes, 0));

  const view: FleetWtCacheView = { v: 1, generatedAt: new Date(now).toISOString(), root, apply, caches, kinds, freeGb };
  if (json) {
    process.stdout.write(JSON.stringify(view, null, 2) + '\n');
  } else {
    for (const k of kinds) console.log(`${k.kind}: ${k.count} dirs, ${k.gb} GB`);
    for (const c of caches) if (c.removed === false) console.log(`FAILED ${c.path}: ${c.error}`);
    console.log(`free: ${freeGb} GB${apply ? '' : ' (dry run; add --apply to delete)'}`);
  }
  return failed ? 1 : 0;
}
