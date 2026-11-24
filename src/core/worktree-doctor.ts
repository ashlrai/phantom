/**
 * `phm doctor worktree`: can this checkout run the typechecker and linter?
 * Read-only. Every probe is injectable so tests use plain fixture folders.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const WORKTREE_DOCTOR_SCHEMA = 'phm.doctor.worktree/1';

export type ToolState = 'ok' | 'missing' | 'broken';

export interface WorktreeCheck {
  state: ToolState;
  /** One plain sentence. */
  detail: string;
  /** The one command that fixes it, or null when nothing is needed. */
  fix: string | null;
}

/** One line of bridge-source-repair.jsonl, trimmed to what a person needs. */
export interface RepairLogEntry {
  at: string | null;
  /** probe = tools already worked; repaired / failed / skipped = the self-heal ran. */
  event: string;
  reason: string | null;
}

export type LockMatch = 'match' | 'mismatch' | 'unknown';

/** The checkout whose node_modules the fleet copies into every worktree. Everything is read-only and unknown when unreadable. */
export interface SourceReport {
  path: string | null;
  branch: string | null;
  /** Commits on origin/master that the source checkout does not have. */
  behind: number | null;
  /** Does the source package-lock.json hash equal origin/master's? A mismatch is the real cause of missing tools. */
  lock: LockMatch;
  /** Last 5 lines of bridge-source-repair.jsonl, oldest first; empty when there is no log. */
  repairLog: RepairLogEntry[];
}

export interface WorktreeRepair {
  ran: boolean;
  ok: boolean;
  /** One plain sentence about what happened. */
  detail: string;
}

export interface WorktreeReport {
  schema: typeof WORKTREE_DOCTOR_SCHEMA;
  root: string;
  ok: boolean;
  source: SourceReport;
  /** Plain-words reason the tools are missing, or null when nothing is wrong. */
  cause: string | null;
  /** Present only after `--repair`. */
  repair?: WorktreeRepair;
  nodeModules: WorktreeCheck & { shared: boolean };
  tsgo: WorktreeCheck;
  eslint: WorktreeCheck;
  /** The single next step, or null when everything works. */
  nextStep: string | null;
}

export interface WorktreeProbe {
  exists(path: string): boolean;
  isSymlink(path: string): boolean;
  /** Resolves symlinks; throws when the target is gone. */
  realpath(path: string): string;
  /** Runs a tool with --version; true when it exits 0. */
  starts(command: string, args: string[], cwd: string): boolean;
  /** Read-only git; trimmed stdout, or null when git fails. */
  git(args: string[], cwd: string): string | null;
  /** File text, or null when unreadable. */
  readText(path: string): string | null;
}

const REINSTALL = 'npm ci --ignore-scripts --no-audit --no-fund';

export const realProbe: WorktreeProbe = {
  exists: (path) => existsSync(path),
  isSymlink: (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } },
  realpath: (path) => realpathSync(path),
  starts(command, args, cwd) {
    const run = spawnSync(command, args, { cwd, stdio: 'ignore', timeout: 20_000 });
    return run.status === 0;
  },
  git(args, cwd) {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return run.status === 0 && typeof run.stdout === 'string' ? run.stdout.trim() : null;
  },
  readText(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } },
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The checkout that owns this worktree's git data: the fleet's node_modules source. Null when unknown. */
export function findSource(root: string, probe: WorktreeProbe): string | null {
  const common = probe.git(['rev-parse', '--git-common-dir'], root);
  if (!common) return null;
  const dir = resolve(root, common);
  return basename(dir) === '.git' ? dirname(dir) : null;
}

/** Same location rule as scripts/bridge-heal.mjs healPaths(): inside .git when the source has one. */
export function repairLogPath(source: string): string {
  const git = join(source, '.git');
  try { return join(statSync(git).isDirectory() ? git : source, 'bridge-source-repair.jsonl'); } catch { return join(source, 'bridge-source-repair.jsonl'); }
}

export function readRepairLog(source: string, probe: WorktreeProbe, limit = 5): RepairLogEntry[] {
  const text = probe.readText(repairLogPath(source));
  if (!text) return [];
  const entries: RepairLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      entries.push({
        at: typeof row.at === 'string' ? row.at : null,
        event: typeof row.event === 'string' ? row.event : 'unknown',
        reason: typeof row.reason === 'string' ? row.reason : null,
      });
    } catch { /* skip a torn line */ }
  }
  return entries.slice(-limit);
}

export function inspectSource(root: string, probe: WorktreeProbe): SourceReport {
  const path = findSource(root, probe);
  if (!path) return { path: null, branch: null, behind: null, lock: 'unknown', repairLog: [] };
  const branch = probe.git(['rev-parse', '--abbrev-ref', 'HEAD'], path) || null;
  const count = probe.git(['rev-list', '--count', 'HEAD..origin/master'], path);
  const behind = count !== null && /^\d+$/.test(count) ? Number(count) : null;
  const local = probe.readText(join(path, 'package-lock.json'));
  const master = probe.git(['show', 'origin/master:package-lock.json'], path);
  const lock: LockMatch = local === null || !master ? 'unknown' : sha(local.trim()) === sha(master) ? 'match' : 'mismatch';
  return { path, branch, behind, lock, repairLog: readRepairLog(path, probe) };
}

export function inspectWorktree(root: string, probe: WorktreeProbe = realProbe): WorktreeReport {
  const modules = join(root, 'node_modules');
  const shared = probe.isSymlink(modules);
  const fixInstall = shared ? `rm node_modules && ${REINSTALL}` : REINSTALL;

  let nodeModules: WorktreeReport['nodeModules'];
  let resolves = false;
  if (!probe.exists(modules)) {
    nodeModules = { state: 'missing', shared, detail: 'This checkout has no node_modules folder.', fix: REINSTALL };
  } else {
    try { probe.realpath(modules); resolves = true; } catch { /* dangling link */ }
    nodeModules = resolves
      ? { state: 'ok', shared, detail: shared ? 'node_modules is a link to another checkout (shared, so installs change both).' : 'node_modules is present.', fix: null }
      : { state: 'broken', shared, detail: 'node_modules is a link to a folder that no longer exists.', fix: fixInstall };
  }

  const blocked = (what: string): WorktreeCheck => ({ state: 'missing', detail: `${what} cannot be checked until node_modules works.`, fix: nodeModules.fix });

  let tsgo: WorktreeCheck;
  if (!resolves) tsgo = blocked('tsgo (the fast typechecker)');
  else if (!probe.exists(join(modules, '.bin', 'tsgo'))) {
    tsgo = { state: 'missing', detail: 'tsgo (the fast typechecker) is not installed here; typecheck:fast cannot run.', fix: fixInstall };
  } else if (!probe.starts(join(modules, '.bin', 'tsgo'), ['--version'], root)) {
    tsgo = { state: 'broken', detail: 'tsgo is installed but does not start.', fix: fixInstall };
  } else tsgo = { state: 'ok', detail: 'tsgo starts.', fix: null };

  let eslint: WorktreeCheck;
  if (!resolves) eslint = blocked('eslint');
  else if (!probe.exists(join(modules, 'eslint', 'package.json'))) {
    eslint = { state: 'missing', detail: 'eslint is not installed here; npm run lint cannot run.', fix: fixInstall };
  } else if (!probe.exists(join(modules, 'eslint', 'lib', 'cli.js'))) {
    eslint = { state: 'broken', detail: 'eslint is half installed (its lib folder is missing), so lint fails with "Cannot find module eslint/lib/cli".', fix: fixInstall };
  } else if (!probe.starts(process.execPath, [join(modules, 'eslint', 'bin', 'eslint.js'), '--version'], root)) {
    eslint = { state: 'broken', detail: 'eslint is installed but does not start.', fix: fixInstall };
  } else eslint = { state: 'ok', detail: 'eslint starts.', fix: null };

  const ok = nodeModules.state === 'ok' && tsgo.state === 'ok' && eslint.state === 'ok';
  const nextStep = nodeModules.fix ?? tsgo.fix ?? eslint.fix;
  const source = inspectSource(root, probe);
  const stale = source.lock === 'mismatch' || (source.behind ?? 0) > 0;
  const cause = ok ? null : stale
    ? 'worktree deps came from a stale checkout: its package-lock.json does not match origin/master.'
    : 'tsgo or eslint is missing or broken in this worktree.';
  return { schema: WORKTREE_DOCTOR_SCHEMA, root, ok, source, cause, nodeModules, tsgo, eslint, nextStep };
}

export interface RepairRunner {
  /** Runs one command; resolves to its exit code (null when it could not start). */
  run(command: string, args: string[], cwd: string): number | null;
}

export const realRunner: RepairRunner = {
  run(command, args, cwd) {
    // Output goes to stderr so `--json` stdout stays parseable.
    return spawnSync(command, args, { cwd, stdio: ['ignore', 2, 2], timeout: 15 * 60 * 1000 }).status;
  },
};

/**
 * `--repair`: reinstall dependencies in THIS worktree only, then re-probe.
 * Never touches the source checkout. A lock folder keeps two repairs from
 * running npm ci in the same worktree at once.
 */
export function repairWorktree(root: string, probe: WorktreeProbe = realProbe, runner: RepairRunner = realRunner): WorktreeReport {
  const finish = (repair: WorktreeRepair): WorktreeReport => ({ ...inspectWorktree(root, probe), repair });
  const source = findSource(root, probe);
  const same = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); } };
  if (source && same(source, root)) {
    return finish({ ran: false, ok: false, detail: 'This is the source checkout, not a job worktree. Repair a worktree instead; the source is never changed from here.' });
  }
  const gitDir = probe.git(['rev-parse', '--absolute-git-dir'], root);
  const lock = join(gitDir ?? root, 'bridge-worktree-repair.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return finish({ ran: false, ok: false, detail: code === 'EEXIST' ? 'Another repair is already running in this worktree; wait for it to finish.' : `Could not take the repair lock (${code ?? 'error'}).` });
  }
  try {
    const modules = join(root, 'node_modules');
    // A link to another checkout would make npm ci rewrite that checkout; drop only the link.
    if (probe.isSymlink(modules)) unlinkSync(modules);
    const [command, ...args] = REINSTALL.split(' ') as [string, ...string[]];
    const code = runner.run(command, args, root);
    const after = inspectWorktree(root, probe);
    if (code === 0 && after.ok) return { ...after, repair: { ran: true, ok: true, detail: 'Reinstalled dependencies in this worktree; tsgo and eslint now start.' } };
    return { ...after, repair: { ran: true, ok: false, detail: code === 0 ? 'npm ci finished but tsgo or eslint still does not start.' : `npm ci failed (exit ${code ?? 'did not start'}).` } };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function renderWorktreeReport(report: WorktreeReport): string {
  const mark = (c: WorktreeCheck) => (c.state === 'ok' ? 'ok  ' : 'FAIL');
  const lines = [
    `node_modules  ${mark(report.nodeModules)} ${report.nodeModules.detail}`,
    `tsgo          ${mark(report.tsgo)} ${report.tsgo.detail}`,
    `eslint        ${mark(report.eslint)} ${report.eslint.detail}`,
  ];
  const src = report.source;
  lines.push('');
  if (!src.path) lines.push('source checkout: unknown (git could not tell)');
  else {
    const behind = src.behind === null ? 'unknown' : src.behind === 0 ? 'up to date with origin/master' : `${src.behind} commits behind origin/master`;
    lines.push(`source checkout: ${src.path} on ${src.branch ?? 'unknown branch'}, ${behind}`);
    lines.push(`source lockfile: ${src.lock === 'match' ? 'matches origin/master' : src.lock === 'mismatch' ? 'DIFFERS from origin/master' : 'unknown'}`);
  }
  if (src.repairLog.length === 0) lines.push('source repair log: empty');
  else {
    lines.push('source repair log (latest last):');
    for (const e of src.repairLog) lines.push(`  ${e.at ?? 'unknown time'}  ${e.event}${e.reason ? `: ${e.reason}` : ''}`);
  }
  if (report.cause) lines.push(`\nWhy: ${report.cause}`);
  if (report.repair) lines.push(`\nRepair: ${report.repair.detail}`);
  lines.push(report.nextStep ? `\nNext step: run \`phm doctor worktree --repair\` (it runs \`${report.nextStep}\` here only).` : '\nThis checkout can typecheck and lint.');
  return lines.join('\n');
}
