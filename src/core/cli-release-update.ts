/** CLI package updates for the immutable ship:local releases/<revision> layout. */
import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readPinnedRuntimeArchive, extractPinnedRuntimeArchive } from './local-runtime/archive.js';
import { desktopUpdateProfileForPackage } from './desktop/update-manifest.js';
import { downloadQualifiedUpdateArtifact } from './desktop/qualified-update.js';
import { fsyncDirectory } from './util/durability.js';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REVISION = /^[a-f0-9]{40}$/;
const MAX_ARCHIVE = 128 * 1024 * 1024;

/** Match only the owned layout, including locally shipped dirty snapshots. */
export function isReleaseDirectory(root: string, home: string): boolean {
  return dirname(root) === join(home, '.local/share/ashlr/releases')
    && /^[a-f0-9]{7,40}(?:-dirty-[a-zA-Z0-9-]+)?$/.test(basename(root));
}

async function publicJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error('published metadata unavailable');
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error('published metadata too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Public package metadata needs no npm configuration, credential transport or subprocess. */
export async function publishedNpmVersion(packageName: unknown): Promise<string | null> {
  const profile = desktopUpdateProfileForPackage(packageName);
  try {
    const data = await publicJson(`https://registry.npmjs.org/${encodeURIComponent(profile.packageName)}/latest`) as { version?: unknown };
    return typeof data?.version === 'string' && VERSION.test(data.version) ? data.version : null;
  } catch { return null; }
}

interface ReleaseAsset { name: string; digest: string; size: number; state: string; browser_download_url: string }
export interface CliRelease { version: string; revision: string; url: string; sha256: string; size: number }

/** GitHub's release asset digest is the published checksum for the npm tarball. */
export function parseCliRelease(data: unknown, packageName: unknown): CliRelease {
  const profile = desktopUpdateProfileForPackage(packageName);
  const release = data as { tag_name?: string; target_commitish?: string; draft?: boolean; prerelease?: boolean; assets?: ReleaseAsset[] };
  const version = release?.tag_name?.slice(1) ?? '';
  if (!VERSION.test(version) || release.tag_name !== `v${version}` || release.draft !== false
      || release.prerelease !== false || !REVISION.test(release.target_commitish ?? '') || !Array.isArray(release.assets)) {
    throw new Error('invalid stable release metadata');
  }
  const name = `${profile.archivePrefix}-${version}.tgz`;
  const assets = release.assets.filter(asset => asset?.name === name);
  const asset = assets[0];
  const url = `https://github.com/${profile.repository}/releases/download/v${version}/${name}`;
  if (assets.length !== 1 || !asset || asset.browser_download_url !== url || asset.state !== 'uploaded'
      || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') || !Number.isSafeInteger(asset.size)
      || asset.size < 1 || asset.size > MAX_ARCHIVE) throw new Error('release tarball or SHA256 checksum unavailable');
  return { version, revision: release.target_commitish!, url, sha256: asset.digest.slice(7), size: asset.size };
}

export async function latestCliRelease(packageName: unknown): Promise<CliRelease> {
  const profile = desktopUpdateProfileForPackage(packageName);
  return parseCliRelease(await publicJson(`https://api.github.com/repos/${profile.repository}/releases/latest`), packageName);
}

export function newerCliVersion(candidate: string, installed: string): boolean {
  if (!VERSION.test(installed) || !VERSION.test(candidate)) throw new Error('installed or candidate version is not stable semver');
  const old = installed.split('.').map(BigInt), next = candidate.split('.').map(BigInt);
  const index = next.findIndex((part, i) => part !== old[i]);
  return index >= 0 && next[index]! > old[index]!;
}

function ownedDirectory(path: string): void {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || stat.uid !== process.getuid?.()) throw new Error('update directory must be owned and not writable by others');
}

interface Pointer { path: string; before: string; after: string }
function pointers(root: string, home: string, destination: string): Pointer[] {
  const launcher = join(root, 'bin/ashlr');
  const current = join(home, '.local/share/ashlr/current');
  const result: Pointer[] = [];
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink() && fs.realpathSync(current) === root) {
    result.push({ path: current, before: fs.readlinkSync(current), after: destination });
  }
  for (const name of ['phm', 'ashlr']) {
    const path = join(home, '.local/bin', name);
    if (!fs.existsSync(path)) {
      if (name === 'phm') throw new Error('installed phm symlink is unavailable');
      continue;
    }
    if (!fs.lstatSync(path).isSymbolicLink() || fs.realpathSync(path) !== launcher) throw new Error('installed CLI aliases do not select this release');
    const before = fs.readlinkSync(path);
    const target = resolve(dirname(path), before);
    if (target === launcher) result.push({ path, before, after: join(destination, 'bin/ashlr') });
    else if (target !== join(current, 'bin/ashlr') && !(name === 'phm' && target === join(home, '.local/bin/ashlr'))) {
      throw new Error('unsupported CLI symlink chain');
    }
  }
  if (result.length === 0) throw new Error('no supported release pointer');
  return result;
}

function flip(path: string, expected: string, target: string): void {
  if (!fs.lstatSync(path).isSymbolicLink() || fs.readlinkSync(path) !== expected) throw new Error('release pointer changed during update');
  const temporary = join(dirname(path), `.phm-update-${randomUUID()}`);
  fs.symlinkSync(target, temporary);
  try { fs.renameSync(temporary, path); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export interface CliReleaseUpdateOptions {
  home: string; root: string; release: CliRelease; packageName: unknown;
  /** Recheck resident service absence immediately before code selection. */
  assertServicesAbsent(): void;
}

/** Stage and smoke-test before selection. Failed swaps restore every changed pointer. */
export async function applyCliReleaseUpdate(options: CliReleaseUpdateOptions): Promise<string> {
  const { home, root, release, packageName } = options;
  const profile = desktopUpdateProfileForPackage(packageName);
  if (!VERSION.test(release.version) || !REVISION.test(release.revision) || !/^[a-f0-9]{64}$/.test(release.sha256)
      || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > MAX_ARCHIVE
      || release.url !== `https://github.com/${profile.repository}/releases/download/v${release.version}/${profile.archivePrefix}-${release.version}.tgz`) {
    throw new Error('invalid release pins');
  }
  if (!isReleaseDirectory(root, home) || fs.realpathSync(root) !== root) throw new Error('unsupported release directory');
  for (const relative of ['', '.local', '.local/bin', '.local/share', '.local/share/ashlr', '.local/share/ashlr/releases']) ownedDirectory(join(home, relative));
  ownedDirectory(root);
  const releases = dirname(root), destination = join(releases, release.revision);
  if (destination === root) throw new Error('candidate revision is already installed');
  const selected = pointers(root, home, destination);
  const lock = join(releases, '.phm-update.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  let stage: string | undefined;
  let created = false;
  const changed: Pointer[] = [];
  try {
    options.assertServicesAbsent();
    stage = fs.mkdtempSync(join(releases, '.phm-stage-')); fs.chmodSync(stage, 0o700);
    const data = await downloadQualifiedUpdateArtifact(release.url, release.size);
    if (data.length !== release.size || createHash('sha256').update(data).digest('hex') !== release.sha256) throw new Error('release tarball SHA256 mismatch');
    const artifactPath = join(stage, 'candidate.tgz'); fs.writeFileSync(artifactPath, data, { mode: 0o600, flag: 'wx' });
    const archive = await readPinnedRuntimeArchive({ artifactPath, sha256: release.sha256, revision: release.revision,
      version: release.version, identityProfile: desktopUpdateProfileForPackage(packageName).name });
    const unpacked = join(stage, 'package'); fs.mkdirSync(unpacked, { mode: 0o700 });
    extractPinnedRuntimeArchive(archive, unpacked);
    const smoke = spawnSync(process.execPath, [join(unpacked, 'bin/ashlr'), 'help'], { cwd: unpacked, encoding: 'utf8', timeout: 15_000 });
    if (smoke.error || smoke.status !== 0) throw new Error('candidate CLI help smoke test failed');
    // Never overwrite an existing release, including an interrupted previous attempt.
    if (fs.existsSync(destination)) throw new Error('candidate release directory already exists');
    fs.renameSync(unpacked, destination); created = true; fsyncDirectory(releases);
    options.assertServicesAbsent();
    for (const pointer of selected) {
      flip(pointer.path, pointer.before, pointer.after); changed.push(pointer); fsyncDirectory(dirname(pointer.path));
    }
    const logDirectory = join(home, '.ashlr-runs');
    fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 }); ownedDirectory(logDirectory);
    const fd = fs.openSync(join(logDirectory, 'installs.log'), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error('unsafe installs.log');
      fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), action: 'phm-update', version: release.version,
        revision: release.revision, previous: basename(root), sha256: release.sha256 }) + '\n'); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fsyncDirectory(logDirectory);
    return destination;
  } catch (error) {
    for (const pointer of changed.reverse()) { flip(pointer.path, pointer.after, pointer.before); fsyncDirectory(dirname(pointer.path)); }
    if (created) { fs.rmSync(destination, { recursive: true }); fsyncDirectory(releases); }
    throw error;
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
}
