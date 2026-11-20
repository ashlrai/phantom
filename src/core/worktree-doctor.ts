/**
 * `phm doctor worktree`: can this checkout run the typechecker and linter?
 * Read-only. Every probe is injectable so tests use plain fixture folders.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const WORKTREE_DOCTOR_SCHEMA = 'phm.doctor.worktree/1';

export type ToolState = 'ok' | 'missing' | 'broken';

export interface WorktreeCheck {
  state: ToolState;
  /** One plain sentence. */
  detail: string;
  /** The one command that fixes it, or null when nothing is needed. */
  fix: string | null;
}

export interface WorktreeReport {
  schema: typeof WORKTREE_DOCTOR_SCHEMA;
  root: string;
  ok: boolean;
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
};

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
  return { schema: WORKTREE_DOCTOR_SCHEMA, root, ok, nodeModules, tsgo, eslint, nextStep };
}

export function renderWorktreeReport(report: WorktreeReport): string {
  const mark = (c: WorktreeCheck) => (c.state === 'ok' ? 'ok  ' : 'FAIL');
  const lines = [
    `node_modules  ${mark(report.nodeModules)} ${report.nodeModules.detail}`,
    `tsgo          ${mark(report.tsgo)} ${report.tsgo.detail}`,
    `eslint        ${mark(report.eslint)} ${report.eslint.detail}`,
  ];
  lines.push(report.nextStep ? `\nFix everything with one command:\n  ${report.nextStep}` : '\nThis checkout can typecheck and lint.');
  return lines.join('\n');
}
