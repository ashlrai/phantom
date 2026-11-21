import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NPM_BUILD_STEPS, RELEASE_BUILD_OUTPUTS } from './build-outputs.mjs';

let temporaryFileSequence = 0;

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function breakHardLink(path, expected) {
  let sourceFd;
  let temporaryFd;
  let temporaryPath;
  try {
    try {
      sourceFd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error.code === 'ELOOP' || error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
    const sourceStat = fstatSync(sourceFd);
    if (!sourceStat.isFile() || sourceStat.dev !== expected.dev || sourceStat.ino !== expected.ino) return false;
    if (sourceStat.nlink <= 1) return true;

    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = join(dirname(path), `.build-normalize-${process.pid}-${temporaryFileSequence++}.tmp`);
      try {
        temporaryFd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        temporaryPath = candidate;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (temporaryFd === undefined) throw new Error('could not create build normalization temp file');

    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const count = writeSync(temporaryFd, buffer, bytesWritten, bytesRead - bytesWritten);
        if (count === 0) throw new Error('short write while copying build output');
        bytesWritten += count;
      }
    }

    const current = lstatIfPresent(path);
    if (!current || current.isSymbolicLink() || !current.isFile() ||
      current.dev !== sourceStat.dev || current.ino !== sourceStat.ino) return false;
    closeSync(temporaryFd);
    temporaryFd = undefined;
    renameSync(temporaryPath, path);
    temporaryPath = undefined;
    return true;
  } finally {
    if (sourceFd !== undefined) closeSync(sourceFd);
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    if (temporaryPath) {
      try { unlinkSync(temporaryPath); } catch { /* already gone */ }
    }
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
    if ((stat.mode & 0o777) !== mode) {
      if (stat.nlink > 1 && !breakHardLink(path, stat)) return;
      const current = lstatIfPresent(path);
      if (!current || current.isSymbolicLink() || !current.isFile()) return;
      chmodSync(path, mode);
    }
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
    normalizeBuildOutputs(cwd);
    for (const [index, { command, normalizeBefore }] of steps.entries()) {
      if (normalizeBefore && index > 0) normalizeBuildOutputs(cwd);
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
