import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NPM_BUILD_STEPS, RELEASE_BUILD_OUTPUTS } from './build-outputs.mjs';

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function outputPaths(root, output) {
  if (!output || isAbsolute(output) || output.includes('\\')) return [];
  const segments = output.replace(/\/$/, '').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return [];

  let parents = [root];
  for (const segment of segments) {
    const next = [];
    for (const parent of parents) {
      const parentStat = lstatIfPresent(parent);
      if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) continue;
      const names = segment.includes('*')
        ? readdirSync(parent).filter((name) =>
          new RegExp(`^${segment.split('*').map(escapeRegExp).join('[^/]*')}$`).test(name))
        : [segment];
      for (const name of names) {
        const path = join(parent, name);
        const stat = lstatIfPresent(path);
        if (stat && !stat.isSymbolicLink()) next.push(path);
      }
    }
    parents = next;
  }
  return parents;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOutput(path) {
  const stat = lstatIfPresent(path);
  if (!stat || stat.isSymbolicLink()) return;

  if (stat.isDirectory()) {
    if ((stat.mode & 0o777) !== 0o755) chmodSync(path, 0o755);
    for (const name of readdirSync(path)) normalizeOutput(join(path, name));
    return;
  }
  if (stat.isFile()) {
    const mode = (stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
    if ((stat.mode & 0o777) !== mode) chmodSync(path, mode);
  }
}

function normalizeBuildOutputs(root) {
  const rootPath = resolve(root);
  const rootStat = lstatIfPresent(rootPath);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return;
  for (const output of RELEASE_BUILD_OUTPUTS) {
    for (const path of outputPaths(rootPath, output)) normalizeOutput(path);
  }
}

export function runBuild(steps = NPM_BUILD_STEPS, spawn = spawnSync, root = process.cwd()) {
  const cwd = resolve(root);
  const previousMask = process.umask(0o022);
  try {
    for (const { command } of steps) {
      const result = spawn(command, { cwd, shell: true, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
    normalizeBuildOutputs(cwd);
    return 0;
  } finally {
    process.umask(previousMask);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runBuild();
}
