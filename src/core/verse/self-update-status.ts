import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpsSelfUpdateActionResult } from './ops-types.js';

import { readSelfUpdateLastApply, type OpsSelfUpdateWithLastApply, type SelfUpdateLastApply } from './self-update-last.js';

export interface SelfUpdateDeps {
  readLastApply?: () => SelfUpdateLastApply | null;
  runGit?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
  repoRoot?: () => string | null;
  readPackageVersion?: (root: string) => string | null;
  statFetchHead?: (root: string) => Date | null;
  now?: () => number;
}

function repoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, '.git')) && existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const require = createRequire(import.meta.url);
function readPackageVersion(root: string): string | null {
  const pkg = require(join(root, 'package.json')) as { version?: unknown };
  return typeof pkg.version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(pkg.version) ? pkg.version : null;
}

function statFetchHead(root: string): Date | null {
  let gitDir = join(root, '.git');
  if (statSync(gitDir).isFile()) {
    // Worktrees have a gitdir pointer rather than a .git directory.
    if (statSync(gitDir).size > 4096) return null;
    const pointer = readFileSync(gitDir, 'utf8').trim();
    if (!pointer.startsWith('gitdir: ')) return null;
    gitDir = resolve(root, pointer.slice(8));
  }
  try { return statSync(join(gitDir, 'FETCH_HEAD')).mtime; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const runGit: NonNullable<SelfUpdateDeps['runGit']> = (args, cwd) => new Promise((done) => {
  execFile('git', args, {
    cwd, encoding: 'utf8', timeout: args[0] === 'fetch' ? 30_000 : 8000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  }, (error, stdout) => done({ code: error ? 1 : 0, stdout }));
});

let processHeadSha: string | null = null;

export function resetProcessHeadShaForTests(): void {
  processHeadSha = null;
}

export async function readSelfUpdateStatus(deps: SelfUpdateDeps = {}): Promise<OpsSelfUpdateWithLastApply> {
  const now = (deps.now ?? Date.now)();
  const uptimeSeconds = process.uptime();
  let lastApply: SelfUpdateLastApply | null = null;
  try { lastApply = (deps.readLastApply ?? readSelfUpdateLastApply)(); } catch { /* History is advisory. */ }
  const result: OpsSelfUpdateWithLastApply = {
    lastApply, v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy',
    installedVersion: null, repoRoot: false, headSha: null, processHeadSha, headAt: null, originSha: null,
    branch: null, behind: null, ahead: null, dirty: null, lastFetchAt: null,
    processStartedAt: new Date(now - uptimeSeconds * 1000).toISOString(), uptimeSeconds, pid: process.pid,
    canFastForward: null,
  };
  const guarded = <T>(fn: () => T): T | null => {
    try { return fn(); } catch { result.sourceState = 'degraded'; return null; }
  };
  const root = guarded(deps.repoRoot ?? repoRoot);
  if (!root) { result.sourceState = 'unavailable'; return result; }
  result.repoRoot = true;
  result.installedVersion = guarded(() => (deps.readPackageVersion ?? readPackageVersion)(root));
  if (result.installedVersion === null) result.sourceState = 'degraded';
  result.lastFetchAt = guarded(() => (deps.statFetchHead ?? statFetchHead)(root)?.toISOString() ?? null);
  const git = async (args: string[], valid: (text: string) => boolean): Promise<string | null> => {
    try {
      const out = await (deps.runGit ?? runGit)(args, root);
      const text = out.stdout.trim();
      if (out.code === 0 && valid(text)) return text;
    } catch { /* Independently degrade each probe; never expose git errors. */ }
    result.sourceState = 'degraded';
    return null;
  };
  const sha = (text: string) => /^[a-f0-9]{40,64}$/.test(text);
  const [head, at, origin, branch, counts, status] = await Promise.all([
    git(['rev-parse', 'HEAD'], sha),
    git(['show', '-s', '--format=%cI', 'HEAD'], (s) => /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s))),
    git(['rev-parse', 'origin/master'], sha),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], (s) => /^[A-Za-z0-9._/-]{1,200}$/.test(s)),
    git(['rev-list', '--left-right', '--count', 'HEAD...origin/master'], (s) => /^\d+\s+\d+$/.test(s) && s.split(/\s+/).every((n) => Number.isSafeInteger(Number(n)))),
    git(['status', '--porcelain'], () => true),
  ]);
  if (processHeadSha === null && head !== null && /^[a-f0-9]{40}$/.test(head)) processHeadSha = head;
  result.headSha = head; result.processHeadSha = processHeadSha; result.headAt = at; result.originSha = origin; result.branch = branch;
  if (counts !== null) [result.ahead, result.behind] = counts.split(/\s+/).map(Number) as [number, number];
  result.dirty = status === null ? null : status.length > 0;
  if (result.behind !== null && result.ahead !== null && result.dirty !== null) {
    result.canFastForward = result.behind > 0 && result.ahead === 0 && result.dirty === false;
  }
  return result;
}

export async function fetchOrigin(deps: SelfUpdateDeps = {}): Promise<OpsSelfUpdateActionResult> {
  const failed = (reason: string): OpsSelfUpdateActionResult => ({ ok: false, action: 'fetch', fetchedAt: null, reason });
  try {
    const root = (deps.repoRoot ?? repoRoot)();
    if (!root) return failed('Repository unavailable');
    const out = await (deps.runGit ?? runGit)(['fetch', '--quiet', 'origin', 'master'], root);
    if (out.code !== 0) return failed('Fetch failed');
    return { ok: true, action: 'fetch', fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(), reason: null };
  } catch { return failed('Fetch failed'); }
}
