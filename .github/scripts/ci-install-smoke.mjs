#!/usr/bin/env node
/* global process, console, fetch, URL */
// README quickstart, from this commit's pack and from the published release.
// `npm install -g @ashlr/phantom` then `phm --version` must exit 0.
// The published tarball is hashed against dist.integrity before it is written or run.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = '@ashlr/phantom';

export function phmCandidates(prefix) {
  if (process.platform === 'win32') return [join(prefix, 'phm.cmd'), join(prefix, 'phm')];
  return [join(prefix, 'bin', 'phm'), join(prefix, 'bin', 'ashlr')];
}

export function findPhm(prefix) {
  const found = phmCandidates(prefix).find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`installed phm not found under ${prefix}`);
  return found;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? 'signal'}`);
  }
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? 'signal'}`);
  }
  return (result.stdout ?? '').trim();
}

export function parseCliVersion(output) {
  const line = String(output ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  const match = /^(?:phm |ashlr |v)?(\d+\.\d+\.\d+)$/.exec(line);
  return match ? match[1] : '';
}

function repoVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error('package.json version is missing');
  }
  return pkg.version;
}

export function assertVersion(bin, expected) {
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const actual = result.status === 0 ? parseCliVersion(result.stdout) : '';
  if (actual !== expected) {
    const line = (new Error().stack ?? '').match(/ci-install-smoke\.mjs:(\d+)/)?.[1] ?? '0';
    const shown = actual || '(none)';
    throw new Error(`::error file=.github/scripts/ci-install-smoke.mjs,line=${line}::installed phm version ${shown}, expected ${expected}`);
  }
  console.log(`phm --version ${actual}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `phm --version ${actual}\n`);
  return actual;
}

function installPrefix(label) {
  const root = process.env.RUNNER_TEMP || tmpdir();
  return mkdtempSync(join(root, `phantom-install-${label}-`));
}

export function smokeCommit() {
  run('npm', ['run', 'build']);
  const dest = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'phantom-pack-'));
  run('npm', ['pack', '--pack-destination', dest]);
  const tarball = readdirSync(dest).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  const prefix = installPrefix('commit');
  run('npm', ['install', '-g', '--prefix', prefix, join(dest, tarball)]);
  return assertVersion(findPhm(prefix), repoVersion());
}

// npm view <pkg> version dist.integrity dist.tarball --json uses dotted keys.
export function releaseChecksumFields(value) {
  if (!value || typeof value !== 'object') throw new Error('published release metadata is missing');
  const version = typeof value.version === 'string' ? value.version : '';
  const integrity = typeof value['dist.integrity'] === 'string' ? value['dist.integrity']
    : value.dist && typeof value.dist.integrity === 'string' ? value.dist.integrity : '';
  const tarball = typeof value['dist.tarball'] === 'string' ? value['dist.tarball']
    : value.dist && typeof value.dist.tarball === 'string' ? value.dist.tarball : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected published version: ${version}`);
  if (!tarball.startsWith('https://')) throw new Error('published release tarball URL is missing');
  if (!integrity) throw new Error('published release checksum is missing');
  return { version, integrity, tarball };
}

export function assertReleaseChecksum(bytes, integrity) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('published release tarball is missing');
  if (typeof integrity !== 'string' || integrity.length === 0) throw new Error('published release checksum is missing');
  const token = integrity.split(/\s+/).find((part) => part.startsWith('sha512-'));
  const expected = token ? token.slice('sha512-'.length) : '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(expected)) throw new Error('published release checksum is missing');
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (actual !== expected) throw new Error('published release checksum mismatch');
}

async function downloadReleaseTarball(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`published release download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes;
}

export async function smokeRelease() {
  const meta = releaseChecksumFields(JSON.parse(capture('npm', ['view', PACKAGE, 'version', 'dist.integrity', 'dist.tarball', '--json'])));
  const bytes = await downloadReleaseTarball(meta.tarball);
  assertReleaseChecksum(bytes, meta.integrity);
  const dest = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'phantom-release-'));
  const tarball = join(dest, 'release.tgz');
  writeFileSync(tarball, bytes);
  console.log(`published ${PACKAGE}@${meta.version} checksum ok`);
  const prefix = installPrefix('release');
  run('npm', ['install', '-g', '--prefix', prefix, tarball]);
  return assertVersion(findPhm(prefix), meta.version);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2];
  try {
    if (target === 'commit') smokeCommit();
    else if (target === 'release') await smokeRelease();
    else throw new Error('usage: ci-install-smoke.mjs commit|release');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
