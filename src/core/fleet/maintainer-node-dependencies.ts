import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { accessSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import type { VerifyCommand } from '../run/verify-commands.js';

const LIMIT = 20_000;
const REGISTRY = 'https://registry.npmjs.org/';
const MANAGERS = new Set(['pnpm', 'bun', 'npm', 'npx', 'yarn']);
const ALLOWED_CONFIG = new Set(['auto-install-peers', 'strict-peer-dependencies', 'shamefully-hoist', 'node-linker']);
const SOURCE_TREE = /^[a-f0-9]{40}$/;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
function fail(reason: string): never { throw new Error(`maintainer Node dependencies: ${reason}`); }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function pathPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export type MaintainerNodeManager = 'pnpm' | 'bun' | 'npm';
export interface MaintainerNodeReceipt {
  v: 1;
  recipe: 'node-locked-v1';
  manager: MaintainerNodeManager;
  sourceTree: string;
  lockSha256: string;
  packageCount: number;
  nodeModulesSha256: string;
}
export interface MaintainerNodeAttachment {
  readonly receipts: readonly MaintainerNodeReceipt[];
  readonly toolBins: readonly string[];
  assertCurrent(worktree: string): void;
  close(): void;
}
export interface MaintainerNodeBinary {
  executable: string;
  binDirs: readonly string[];
}
export interface MaintainerNodePreparationDeps {
  runSubprocess: typeof runVerifySubprocessAsync;
  resolveBinary(name: string): MaintainerNodeBinary;
}
const defaults: MaintainerNodePreparationDeps = {
  runSubprocess: runVerifySubprocessAsync,
  resolveBinary: resolveBinaryFromPath,
};
const admitted = new WeakSet<MaintainerNodeAttachment>();

export function requireMaintainerNodeAttachment(value: MaintainerNodeAttachment): void {
  if (!admitted.has(value)) fail('attachment was not created by this host invocation');
}

export function needsMaintainerNode(commands: readonly VerifyCommand[]): boolean {
  return commands.some((command) => MANAGERS.has(command.cmd[0] ?? ''));
}

function regularBytes(path: string, limit = 32 * 1024 * 1024): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit) || realpathSync(path) !== resolve(path)) fail('unsafe-input-file');
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs || bytes.length !== Number(after.size)) fail('input-changed-while-reading');
  return bytes;
}

function safeWorktreePath(worktree: string, cwd: string): string {
  if (cwd.includes('\0') || isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) fail('unsafe-command-cwd');
  const target = resolve(worktree, cwd || '.');
  if (!inside(worktree, target)) fail('unsafe-command-cwd');
  let current = worktree;
  for (const part of relative(worktree, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      const real = realpathSync(current);
      if (!inside(worktree, real)) fail('command-cwd-symlink-escape');
      current = real;
    }
  }
  if (!existsSync(target) || !lstatSync(target).isDirectory() || !inside(worktree, realpathSync(target))) fail('unsafe-command-cwd');
  return realpathSync(target);
}

function localPath(worktree: string, base: string, value: string): void {
  if (!value || value.includes('\0') || isAbsolute(value)) fail('workspace-link-outside');
  const target = resolve(base, value);
  if (!inside(worktree, target)) fail('workspace-link-outside');
  let real: string;
  try { real = realpathSync(target); } catch { return fail('workspace-link-missing'); }
  if (!inside(worktree, real)) fail('workspace-link-symlink-escape');
}

function sha512Integrity(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.split(/\s+/).some((entry) => {
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(entry);
    if (!match) return false;
    const bytes = Buffer.from(match[1]!, 'base64');
    return bytes.length === 64 && bytes.toString('base64').replace(/=+$/, '') === match[1]!.replace(/=+$/, '');
  });
}

function registryTarball(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { return fail('invalid-tarball-url'); }
  if (url.protocol !== 'https:') fail('insecure-tarball');
  if (url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash) fail('custom-registry');
  if (!url.pathname.startsWith('/') || url.pathname.split('/').includes('..')) fail('invalid-tarball-url');
}

function workspaceNames(worktree: string, root: string, importers: readonly string[]): Set<string> {
  const names = new Set<string>();
  const dirs = new Set([root]);
  for (const importer of importers) {
    if (importer.includes('\0') || importer.split(/[\\/]/).includes('..') || isAbsolute(importer)) fail('invalid-workspace-importer');
    const dir = safeWorktreePath(worktree, relative(worktree, resolve(root, importer || '.')));
    dirs.add(dir);
  }
  for (const dir of dirs) {
    const path = join(dir, 'package.json');
    if (!existsSync(path)) continue;
    let manifest: Record<string, unknown> | null;
    try { manifest = object(JSON.parse(regularBytes(path).toString('utf8'))); } catch { return fail('invalid-workspace-manifest'); }
    if (typeof manifest?.['name'] === 'string') names.add(manifest['name']);
  }
  return names;
}

function localReference(
  value: string | undefined,
  worktree: string,
  root: string,
  importer: string,
  packageName: string,
  names: ReadonlySet<string>,
): boolean {
  if (!value) return false;
  if (/^(?:git\+|git:|github:|ssh:)/i.test(value)) fail('git-source');
  if (value.startsWith('file:') || value.startsWith('link:')) {
    localPath(worktree, resolve(root, importer || '.'), value.slice(value.indexOf(':') + 1));
    return true;
  }
  if (value.startsWith('workspace:')) {
    const target = value.slice('workspace:'.length);
    if (target.startsWith('./') || target.startsWith('../')) localPath(worktree, resolve(root, importer || '.'), target);
    else if (!names.has(packageName)) fail('workspace-package-missing');
    return true;
  }
  if (/^http:/i.test(value)) fail('insecure-tarball');
  if (/^https:/i.test(value)) registryTarball(value);
  return false;
}

function dependencyEntries(value: unknown): Record<string, unknown> | null {
  return value === undefined ? null : object(value);
}

function validatePnpm(text: string, worktree: string, root: string): number {
  let doc: Record<string, unknown> | null;
  try { doc = object(parseYaml(text, { uniqueKeys: true })); } catch { return fail('malformed-pnpm-lock'); }
  if (!doc) fail('invalid-pnpm-lock');
  const version = doc['lockfileVersion'];
  if (!(version === '9.0' || version === 9 || version === 9.0)) fail('unsupported-lockfile-version');
  if ('patchedDependencies' in doc) fail('patched-dependencies');
  if ('registries' in doc) fail('custom-registry');
  const importers = object(doc['importers']);
  const packages = object(doc['packages']);
  if (!importers || !packages) fail('unsupported-pnpm-lock-schema');
  if (Object.keys(importers).length > LIMIT) fail('package-count-limit');
  if (Object.keys(packages).length > LIMIT) fail('package-count-limit');
  const names = workspaceNames(worktree, root, Object.keys(importers));
  for (const [importer, value] of Object.entries(importers)) {
    const entry = object(value);
    if (!entry) fail('invalid-workspace-importer');
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = dependencyEntries(entry[section]);
      if (entry[section] !== undefined && !deps) fail('invalid-workspace-dependencies');
      for (const [name, raw] of Object.entries(deps ?? {})) {
        const dep = object(raw);
        if (!dep || typeof dep['version'] !== 'string') fail('invalid-workspace-dependency');
        const specifier = typeof dep['specifier'] === 'string' ? dep['specifier'] : undefined;
        localReference(specifier, worktree, root, importer, name, names);
        const local = localReference(dep['version'], worktree, root, importer, name, names);
        if (!local && typeof dep['version'] === 'string' && /^(?:git\+|git:|github:|ssh:)/i.test(dep['version'])) fail('git-source');
      }
    }
  }
  for (const [key, raw] of Object.entries(packages)) {
    const pkg = object(raw);
    const resolution = object(pkg?.['resolution']);
    if (!pkg || !resolution) fail('unsupported-package-resolution');
    if ('repo' in resolution || 'commit' in resolution) fail('git-source');
    if ('registry' in resolution) fail('custom-registry');
    const resolutionKeys = new Set(['integrity', 'tarball', 'directory', 'type']);
    if (Object.keys(resolution).some((name) => !resolutionKeys.has(name)) ||
        (resolution['type'] !== undefined && resolution['type'] !== 'directory') ||
        (resolution['type'] === 'directory' && typeof resolution['directory'] !== 'string')) fail('unsupported-package-resolution');
    const integrity = resolution['integrity'] ?? pkg['integrity'];
    let local = false;
    if (typeof resolution['directory'] === 'string') {
      localPath(worktree, root, resolution['directory']);
      local = true;
    }
    const tarball = resolution['tarball'];
    if (typeof tarball === 'string') {
      local = localReference(tarball, worktree, root, '.', key, names);
      if (!local) registryTarball(tarball);
    }
    if (!local && !sha512Integrity(integrity)) fail('missing-sha512-integrity');
  }
  return Object.keys(packages).length;
}

function stripJsonc(text: string): string {
  let comments = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const next = text[i + 1];
    if (quoted) {
      comments += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      comments += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      comments += text[i] ?? '';
    } else if (char === '/' && next === '*') {
      i += 2;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') { i++; closed = true; break; }
        if (text[i] === '\n' || text[i] === '\r') comments += text[i];
        i++;
      }
      if (!closed) fail('malformed-bun-jsonc');
    } else comments += char;
  }
  if (quoted) fail('malformed-bun-jsonc');
  let clean = '';
  quoted = false; escaped = false;
  for (let i = 0; i < comments.length; i++) {
    const char = comments[i]!;
    if (quoted) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true; clean += char;
    } else if (char === ',') {
      let next = i + 1;
      while (/\s/.test(comments[next] ?? '')) next++;
      if (comments[next] !== '}' && comments[next] !== ']') clean += char;
    } else clean += char;
  }
  return clean;
}

function bunPackageName(key: string): string {
  if (key.startsWith('@')) {
    const slash = key.indexOf('/');
    const at = key.indexOf('@', slash + 1);
    return at < 0 ? key : key.slice(0, at);
  }
  const at = key.indexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

function validateBun(text: string, worktree: string, root: string): number {
  let doc: Record<string, unknown> | null;
  try { doc = object(JSON.parse(stripJsonc(text))); } catch { return fail('malformed-bun-lock'); }
  if (!doc) fail('invalid-bun-lock');
  if (!(doc['lockfileVersion'] === 1 || doc['lockfileVersion'] === '1')) fail('unsupported-lockfile-version');
  if ('patchedDependencies' in doc) fail('patched-dependencies');
  const packages = object(doc['packages']);
  const workspaces = object(doc['workspaces']);
  if (!packages || !workspaces) fail('unsupported-bun-lock-schema');
  if (Object.keys(workspaces).length > LIMIT) fail('package-count-limit');
  if (Object.keys(packages).length > LIMIT) fail('package-count-limit');
  const names = workspaceNames(worktree, root, Object.keys(workspaces));
  for (const [importer, raw] of Object.entries(workspaces)) {
    const entry = object(raw);
    if (!entry) fail('invalid-workspace-importer');
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = dependencyEntries(entry[section]);
      if (entry[section] !== undefined && !deps) fail('invalid-workspace-dependencies');
      for (const [name, spec] of Object.entries(deps ?? {})) {
        if (typeof spec !== 'string') fail('invalid-workspace-dependency');
        localReference(spec, worktree, root, importer, name, names);
      }
    }
  }
  for (const [key, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== 'string' || !object(raw[2])) fail('unsupported-bun-package-entry');
    const resolved = raw[0] as string;
    const metadata = object(raw[2])!;
    let local = false;
    if (/^(?:file:|link:|workspace:)/.test(resolved)) {
      local = localReference(resolved, worktree, root, '.', bunPackageName(key), names);
    } else if (/^(?:git\+|git:|github:|ssh:)/i.test(resolved)) fail('git-source');
    else if (/^http:/i.test(resolved)) fail('insecure-tarball');
    else if (/^https:/i.test(resolved)) registryTarball(resolved);
    else if (!local && !resolved.startsWith(`${bunPackageName(key)}@`)) fail('unsupported-package-resolution');
    const integrity = metadata['integrity'] ?? raw[3];
    if (!local && !sha512Integrity(integrity)) fail('missing-sha512-integrity');
  }
  return Object.keys(packages).length;
}

function validateNpm(text: string, worktree: string, root: string): number {
  let doc: Record<string, unknown> | null;
  try { doc = object(JSON.parse(text)); } catch { return fail('malformed-package-lock'); }
  if (!doc) fail('invalid-package-lock');
  if (doc['lockfileVersion'] !== 3) fail('unsupported-lockfile-version');
  if ('patchedDependencies' in doc) fail('patched-dependencies');
  const packages = object(doc['packages']);
  if (!packages) fail('unsupported-package-lock-schema');
  const entries = Object.entries(packages).filter(([path]) => path !== '');
  if (entries.length > LIMIT) fail('package-count-limit');
  for (const [path, raw] of entries) {
    const pkg = object(raw);
    if (!pkg) fail('invalid-package-lock-entry');
    const resolved = pkg['resolved'];
    if (pkg['link'] === true) {
      if (typeof resolved !== 'string') fail('invalid-workspace-link');
      localPath(worktree, root, resolved.startsWith('file:') ? resolved.slice(5) : resolved);
      continue;
    }
    if (typeof resolved !== 'string') fail('unsupported-package-resolution');
    if (/^(?:git\+|git:|github:|ssh:)/i.test(resolved)) fail('git-source');
    if (/^(?:file:|link:)/.test(resolved)) {
      localPath(worktree, root, resolved.slice(resolved.indexOf(':') + 1));
      continue;
    }
    if (/^http:/i.test(resolved)) fail('insecure-tarball');
    registryTarball(resolved);
    if (!sha512Integrity(pkg['integrity'])) fail('missing-sha512-integrity');
    if (path.includes('\0')) fail('invalid-package-lock-entry');
  }
  return entries.length;
}

export function validateMaintainerNodeLockfile(
  manager: MaintainerNodeManager,
  text: string,
  worktree: string,
  lockRoot = worktree,
): number {
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) fail('lockfile-too-large');
  if (manager === 'pnpm') return validatePnpm(text, worktree, lockRoot);
  if (manager === 'bun') return validateBun(text, worktree, lockRoot);
  return validateNpm(text, worktree, lockRoot);
}

function allowedNpmrc(text: string): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const key = (line.split(/[=\s]/, 1)[0] ?? '').replace(/^--/, '').toLowerCase();
    if (!ALLOWED_CONFIG.has(key)) fail('disallowed-package-config');
  }
}

function allowedBunfig(text: string): void {
  let doc: Record<string, unknown>;
  try { doc = parseToml(text, { unsafeKeyBehaviour: 'throw' }); } catch { return fail('invalid-package-config'); }
  const visit = (value: unknown, parent: string | null = null): void => {
    const row = object(value);
    if (!row) return;
    for (const [key, field] of Object.entries(row)) {
      if (parent === null && key === 'install') { visit(field, 'install'); continue; }
      if (!ALLOWED_CONFIG.has(key.toLowerCase())) fail('disallowed-package-config');
      if (object(field)) visit(field, key);
    }
  };
  visit(doc);
}

function allowedYarnrc(text: string, yaml: boolean): void {
  if (yaml) {
    let doc: unknown;
    try { doc = parseYaml(text, { uniqueKeys: true }); } catch { return fail('invalid-package-config'); }
    const visit = (value: unknown): void => {
      const row = object(value);
      if (!row) return;
      for (const [key, field] of Object.entries(row)) {
        if (!ALLOWED_CONFIG.has(key.toLowerCase())) fail('disallowed-package-config');
        if (object(field)) visit(field);
      }
    };
    visit(doc);
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const token = line.startsWith('--') ? line.slice(2).split(/[=\s]/, 1)[0] : line.split(/[=\s]/, 1)[0];
    const key = (token ?? '').toLowerCase();
    if (!ALLOWED_CONFIG.has(key)) fail('disallowed-package-config');
  }
}

function validatePackageConfigs(worktree: string): void {
  let visited = 0;
  const walk = (dir: string): void => {
    if (++visited > LIMIT) fail('package-config-scan-limit');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'target', '.next'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(path); continue; }
      if (entry.name === '.npmrc') allowedNpmrc(regularBytes(path).toString('utf8'));
      else if (entry.name === 'bunfig.toml' || entry.name === '.bunfig.toml') allowedBunfig(regularBytes(path).toString('utf8'));
      else if (entry.name === '.yarnrc' || entry.name.startsWith('.yarnrc.')) {
        allowedYarnrc(regularBytes(path).toString('utf8'), /\.(?:yml|yaml)$/i.test(entry.name));
      }
    }
  };
  walk(worktree);
}

function managerForCommand(command: VerifyCommand): MaintainerNodeManager | null {
  const name = command.cmd[0];
  return name === 'pnpm' || name === 'bun' || name === 'npm' ? name : null;
}

function declaredManager(directory: string): MaintainerNodeManager | null {
  const path = join(directory, 'package.json');
  if (!existsSync(path)) return null;
  let manifest: Record<string, unknown> | null;
  try { manifest = object(JSON.parse(regularBytes(path).toString('utf8'))); } catch { return fail('invalid-package-manifest'); }
  const value = manifest?.['packageManager'];
  if (typeof value !== 'string') return null;
  const name = value.split('@', 1)[0];
  return name === 'pnpm' || name === 'bun' || name === 'npm' ? name : null;
}

const LOCKS: readonly { file: string; manager: MaintainerNodeManager }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
];
interface LockPlan {
  path: string;
  root: string;
  manager: MaintainerNodeManager;
  bytes: Buffer;
  lockSha256: string;
  packageCount: number;
}

function lockAt(directory: string, worktree: string, command: VerifyCommand): LockPlan | null {
  if (pathPresent(join(directory, 'bun.lockb'))) fail('bun-lockb-refused');
  if (pathPresent(join(directory, 'yarn.lock')) || pathPresent(join(directory, 'npm-shrinkwrap.json'))) fail('unsupported-lockfile');
  const found = LOCKS.filter(({ file }) => pathPresent(join(directory, file)));
  if (!found.length) return null;
  const preferred = managerForCommand(command) ?? declaredManager(directory) ?? declaredManager(worktree);
  const selected = preferred ? found.find((lock) => lock.manager === preferred) : found.length === 1 ? found[0] : undefined;
  if (!selected) fail('ambiguous-lockfile');
  if (!pathPresent(join(directory, 'package.json'))) fail('package-manifest-missing');
  const path = join(directory, selected.file);
  const bytes = regularBytes(path);
  const packageCount = validateMaintainerNodeLockfile(selected.manager, bytes.toString('utf8'), worktree, directory);
  return { path, root: directory, manager: selected.manager, bytes, lockSha256: hash(bytes), packageCount };
}

function resolveProjectLock(worktree: string, cwd: string, command: VerifyCommand): LockPlan {
  const local = lockAt(cwd, worktree, command);
  if (local) return local;
  const root = lockAt(worktree, worktree, command);
  if (root) return root;
  fail('supported-lockfile-missing');
}

function resolveBinaryFromPath(name: string): MaintainerNodeBinary {
  const pathValue = process.env['PATH'] ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      const real = realpathSync(candidate);
      const stat = statSync(real);
      if (!stat.isFile()) continue;
      if (process.platform !== 'win32') accessSync(real, fsConstants.X_OK);
      const dirs = [...new Set([realpathSync(dirname(candidate)), realpathSync(dirname(real))])];
      return { executable: real, binDirs: dirs };
    } catch { /* try the next absolute PATH entry */ }
  }
  return fail('package-manager-binary-unavailable');
}

function binaryIdentity(path: string): string {
  const real = realpathSync(path);
  const before = statSync(real, { bigint: true });
  if (!before.isFile() || before.size > 256n * 1024n * 1024n) fail('unsafe-package-manager-binary');
  const bytes = readFileSync(real);
  const after = statSync(real, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length !== Number(after.size)) {
    fail('package-manager-binary-changed-while-reading');
  }
  return [real, hash(bytes), after.dev, after.ino, after.mode, after.uid, after.size, after.mtimeNs, after.ctimeNs].join(':');
}

function nodeModulesPaths(worktree: string): string[] {
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string): void => {
    if (++visited > LIMIT * 4) fail('node-modules-scan-limit');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') {
        if (entry.isSymbolicLink() || !entry.isDirectory()) fail('unsafe-node-modules-root');
        out.push(path);
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path);
    }
  };
  walk(worktree);
  return out.sort();
}

function nodeModulesTree(path: string, worktree: string): string {
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path) || !inside(worktree, realpathSync(path))) fail('unsafe-node-modules-root');
  const entries: [string, string][] = [];
  let visited = 0;
  const identity = (target: string): string => {
    const stat = lstatSync(target, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  };
  const walk = (dir: string): void => {
    if (++visited > 200_000) fail('node-modules-tree-limit');
    entries.push([relative(path, dir), identity(dir)]);
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      const rel = relative(path, file);
      if (stat.isSymbolicLink()) {
        const real = realpathSync(file);
        if (!inside(worktree, real)) fail('node-modules-symlink-escape');
        entries.push([rel, `link:${readlinkSync(file)}:${identity(file)}:${identity(real)}`]);
      } else if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) entries.push([rel, identity(file)]);
      else fail('node-modules-special-file');
      if (entries.length > 200_000) fail('node-modules-tree-limit');
    }
  };
  walk(path);
  return hash(JSON.stringify(entries));
}

function nodeModulesDigest(worktree: string): string {
  const paths = nodeModulesPaths(worktree);
  if (!paths.length) fail('node-modules-missing');
  return hash(JSON.stringify(paths.map((path) => [relative(worktree, path), nodeModulesTree(path, worktree)])));
}

function installArgv(manager: MaintainerNodeManager, executable: string): string[] {
  if (manager === 'pnpm') return [executable, 'install', '--frozen-lockfile', '--ignore-scripts', '--config.registry=https://registry.npmjs.org/'];
  if (manager === 'bun') return [executable, 'install', '--frozen-lockfile', '--ignore-scripts'];
  return [executable, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
}

export async function prepareMaintainerNodeDependencies(
  input: { worktree: string; sourceTree: string; commands: readonly VerifyCommand[]; signal?: AbortSignal; assertAuthorized(): void | Promise<void> },
  suppliedDeps: Partial<MaintainerNodePreparationDeps> = {},
): Promise<MaintainerNodeAttachment> {
  const deps = { ...defaults, ...suppliedDeps };
  await input.assertAuthorized();
  if (!SOURCE_TREE.test(input.sourceTree)) fail('invalid-source-tree');
  if (input.signal?.aborted) fail('preparation-cancelled');
  const worktree = realpathSync(input.worktree);
  if (worktree !== resolve(input.worktree)) fail('worktree-not-canonical');
  validatePackageConfigs(worktree);

  const projects = new Map<string, LockPlan>();
  const commandCwds = new Map<string, VerifyCommand>();
  for (const command of input.commands) {
    if (!MANAGERS.has(command.cmd[0] ?? '')) continue;
    const cwd = safeWorktreePath(worktree, command.cwd ?? '.');
    const key = relative(worktree, cwd) || '.';
    if (commandCwds.has(key)) continue;
    commandCwds.set(key, command);
    const plan = resolveProjectLock(worktree, cwd, command);
    projects.set(plan.path, plan);
  }
  if (!projects.size) fail('no-node-projects');
  for (const path of nodeModulesPaths(worktree)) {
    if (existsSync(path)) fail('node-modules-preexisting');
  }

  const bins = new Map<string, MaintainerNodeBinary>();
  for (const plan of projects.values()) if (!bins.has(plan.manager)) bins.set(plan.manager, deps.resolveBinary(plan.manager));
  for (const command of input.commands) {
    const name = command.cmd[0] ?? '';
    if (MANAGERS.has(name) && !bins.has(name)) bins.set(name, deps.resolveBinary(name));
  }
  const nodeExecutable = realpathSync(process.execPath);
  const nodeBin = realpathSync(dirname(nodeExecutable));
  const nodeExecutableIdentity = binaryIdentity(nodeExecutable);
  const toolBins = [...new Set([nodeBin, ...[...bins.values()].flatMap((binary) => binary.binDirs.map((dir) => realpathSync(dir)))])];
  for (const dir of toolBins) {
    if (!isAbsolute(dir) || inside(worktree, dir)) fail('unsafe-package-manager-path');
  }
  const binaryIdentities = new Map([...bins].map(([name, binary]) => [name, binaryIdentity(binary.executable)]));

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-maintainer-node-')));
  chmodSync(root, 0o700);
  const home = join(root, 'home');
  const cache = join(root, 'cache');
  const privateTmp = join(root, 'tmp');
  const corepackHome = join(root, 'corepack');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cache, { mode: 0o700 });
  mkdirSync(privateTmp, { mode: 0o700 });
  mkdirSync(corepackHome, { mode: 0o700 });
  const userConfig = join(root, 'npmrc');
  const globalConfig = join(root, 'global-npmrc');
  writeFileSync(userConfig, '', { mode: 0o600 });
  writeFileSync(globalConfig, '', { mode: 0o600 });
  let closed = false;
  const close = (): void => {
    if (!closed) { rmSync(root, { recursive: true, force: true }); closed = true; }
  };
  try {
    for (const plan of projects.values()) {
      await input.assertAuthorized();
      if (input.signal?.aborted) fail('preparation-cancelled');
      if (!regularBytes(plan.path).equals(plan.bytes)) fail('lockfile-changed-before-install');
      const nodeModules = join(plan.root, 'node_modules');
      if (existsSync(nodeModules)) fail('node-modules-preexisting');
      const binary = bins.get(plan.manager)!;
      const managerCache = join(cache, plan.manager);
      mkdirSync(managerCache, { recursive: true, mode: 0o700 });
      const pathDirs = [...new Set([...binary.binDirs, nodeBin, '/usr/bin', '/bin'])];
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        PATH: pathDirs.join(delimiter),
        npm_config_registry: REGISTRY,
        NPM_CONFIG_REGISTRY: REGISTRY,
        npm_config_cache: managerCache,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        ...(plan.manager === 'pnpm' ? { npm_config_store_dir: managerCache } : {}),
        ...(plan.manager === 'bun' ? { BUN_INSTALL_CACHE_DIR: managerCache } : {}),
        COREPACK_HOME: corepackHome,
        COREPACK_ENABLE_NETWORK: '0',
        TMPDIR: privateTmp,
        TMP: privateTmp,
        TEMP: privateTmp,
        CI: '1',
        LANG: 'C.UTF-8',
      };
      const produced = await deps.runSubprocess(installArgv(plan.manager, binary.executable), {
        cwd: plan.root,
        env,
        timeoutMs: 300_000,
        signal: input.signal,
        requireProcessGroupExit: true,
      });
      await input.assertAuthorized();
      if (produced.exitCode !== 0 || produced.error || produced.cancelled || produced.timedOut ||
          produced.processGroupSettlement !== 'group-exit-confirmed') fail('install-failed-or-unsettled');
      if (!regularBytes(plan.path).equals(plan.bytes)) fail('lockfile-changed-during-install');
    }
    for (const plan of projects.values()) {
      const nodeModules = join(plan.root, 'node_modules');
      if (!existsSync(nodeModules)) mkdirSync(nodeModules, { mode: 0o700 });
    }
    const identities = new Map(nodeModulesPaths(worktree).map((path) => [path, nodeModulesTree(path, worktree)]));
    const nodeModulesSha256 = nodeModulesDigest(worktree);
    const receipts = Object.freeze([...projects.values()].map((plan): MaintainerNodeReceipt => Object.freeze({
      v: 1,
      recipe: 'node-locked-v1',
      manager: plan.manager,
      sourceTree: input.sourceTree,
      lockSha256: plan.lockSha256,
      packageCount: plan.packageCount,
      nodeModulesSha256,
    })));
    const attachment: MaintainerNodeAttachment = Object.freeze({
      receipts,
      toolBins: Object.freeze(toolBins),
      assertCurrent(currentWorktree: string): void {
        if (closed || realpathSync(currentWorktree) !== worktree ||
            [...projects.values()].some((plan) => !regularBytes(plan.path).equals(plan.bytes)) ||
            nodeModulesDigest(worktree) !== nodeModulesSha256 ||
            binaryIdentity(nodeExecutable) !== nodeExecutableIdentity ||
            [...bins].some(([name, binary]) => binaryIdentity(binary.executable) !== binaryIdentities.get(name)) ||
            [...identities].some(([path, identity]) => nodeModulesTree(path, worktree) !== identity)) fail('dependency-attachment-changed');
      },
      close,
    });
    await input.assertAuthorized();
    if (input.signal?.aborted) fail('preparation-cancelled');
    attachment.assertCurrent(worktree);
    admitted.add(attachment);
    return attachment;
  } catch (error) {
    for (const plan of projects.values()) {
      const path = join(plan.root, 'node_modules');
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    close();
    throw error;
  }
}
