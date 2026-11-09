/** Inspect direct worktree dependencies and optionally restore missing entry points. */
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const USAGE = 'Usage: ashlr fleet wt-deps [--dir <worktree>] [--from <donor>] [--apply] [--json]\nChecks direct dependencies for missing package manifests, main and bin files. --from lists matching-version donor files; --apply copies them. Exits 1 if packages remain broken, 2 for invalid options.';
type Manifest = { version?: unknown; main?: unknown; bin?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown> };
export interface WtDepsPackage { name: string; version: string | null; missing: Array<{ path: string; donor: boolean; copied: boolean; error?: string }>; error?: string }
export interface WtDepsReport { v: 1; dir: string; from: string | null; apply: boolean; packages: WtDepsPackage[] }

async function manifest(path: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid package manifest');
  return value as Manifest;
}
function safeRelative(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part !== '..') && path !== '.';
}
function packageName(name: string): boolean {
  return /^(?:@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9._~-]+$/.test(name) && !name.split('/').some(p => p === '.' || p === '..');
}
async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw e; }
}
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); }
// Follow package-manager symlinks at the package root, but never traverse a target symlink outside it.
async function safeParent(root: string, path: string, create: boolean): Promise<void> {
  const realRoot = await realpath(root);
  const parent = dirname(path);
  let current = root;
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; });
    const actual = await realpath(current);
    if (!inside(realRoot, actual)) throw new Error('target escapes package directory');
  }
}
function targets(pkg: Manifest): string[] {
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin) ? Object.values(pkg.bin) : [];
  return [...new Set([pkg.main, ...bins].filter((v): v is string => typeof v === 'string' && v.length > 0))].sort();
}
export async function inspectWtDeps(dir: string, from: string | null, apply: boolean): Promise<WtDepsReport> {
  const root = await manifest(join(dir, 'package.json'));
  const names = new Set<string>();
  for (const group of [root.dependencies, root.devDependencies, root.optionalDependencies, root.peerDependencies]) {
    if (group && typeof group === 'object' && !Array.isArray(group)) for (const name of Object.keys(group)) names.add(name);
  }
  const packages: WtDepsPackage[] = [];
  for (const name of [...names].sort()) {
    const row: WtDepsPackage = { name, version: null, missing: [] };
    if (!packageName(name)) { row.error = 'invalid package name'; packages.push(row); continue; }
    const pkgDir = join(dir, 'node_modules', name);
    let pkg: Manifest;
    try { pkg = await manifest(join(pkgDir, 'package.json')); } catch { row.error = 'package manifest missing or unreadable'; packages.push(row); continue; }
    row.version = typeof pkg.version === 'string' ? pkg.version : null;
    const donorDir = from ? join(from, 'node_modules', name) : null;
    let matching = false;
    if (donorDir && row.version) {
      try { matching = (await manifest(join(donorDir, 'package.json'))).version === row.version; } catch { /* unavailable donor */ }
    }
    for (const target of targets(pkg)) {
      if (!safeRelative(target)) { row.missing.push({ path: target, donor: false, copied: false, error: 'invalid target path' }); continue; }
      const dest = resolve(pkgDir, target);
      if (await isFile(dest)) continue;
      const entry: WtDepsPackage['missing'][number] = { path: target, donor: false, copied: false };
      if (matching && donorDir) {
        const source = resolve(donorDir, target);
        try {
          await safeParent(donorDir, source, false);
          const realSource = await realpath(source);
          entry.donor = inside(await realpath(donorDir), realSource) && await isFile(source);
          if (entry.donor && apply) {
            await safeParent(pkgDir, dest, true);
            await copyFile(source, dest, constants.COPYFILE_EXCL);
            entry.copied = true;
          }
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') entry.error = e instanceof Error ? e.message : String(e); }
      }
      row.missing.push(entry);
    }
    if (row.missing.length) packages.push(row);
  }
  return { v: 1, dir, from, apply, packages };
}
export async function cmdFleetWtDeps(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let dir = process.cwd(), from: string | null = null, apply = false, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--dir', '--from', '--apply', '--json'].includes(arg) || seen.has(arg)) { console.error(`error: invalid or duplicate option: ${arg}\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) { console.error(`error: ${arg} needs a directory\n${USAGE}`); return 2; } if (arg === '--dir') dir = value; else from = value; }
  }
  if (apply && !from) { console.error('error: --apply requires --from'); return 2; }
  try {
    const report = await inspectWtDeps(resolve(dir), from ? resolve(from) : null, apply);
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else if (!report.packages.length) console.log('All dependency entry points are present.');
    else for (const pkg of report.packages) {
      if (pkg.error) console.log(`${pkg.name}: ${pkg.error}`);
      for (const item of pkg.missing) console.log(`${pkg.name}: ${item.path} ${item.copied ? '(copied)' : item.donor ? '(available from donor; add --apply to copy)' : '(missing)'}${item.error ? `: ${item.error}` : ''}`);
    }
    return report.packages.some(pkg => pkg.error || pkg.missing.some(item => !item.copied)) ? 1 : 0;
  } catch (e) { console.error(`error: cannot inspect dependencies: ${e instanceof Error ? e.message : String(e)}`); return 1; }
}
