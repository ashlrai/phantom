#!/usr/bin/env node
/* global process, console */
// README quickstart, from this commit's pack and from the published release.
// `npm install -g @ashlr/phantom` then `phm --version` must exit 0.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
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

function assertVersion(bin) {
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const version = (result.stdout ?? '').trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(`phm --version failed (${result.status}): ${version}`);
  }
  console.log(`phm --version ${version}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `phm --version ${version}\n`);
  return version;
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
  return assertVersion(findPhm(prefix));
}

export function smokeRelease() {
  const version = capture('npm', ['view', PACKAGE, 'version']);
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected published version: ${version}`);
  console.log(`published ${PACKAGE}@${version}`);
  const prefix = installPrefix('release');
  run('npm', ['install', '-g', '--prefix', prefix, `${PACKAGE}@${version}`]);
  return assertVersion(findPhm(prefix));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2];
  try {
    if (target === 'commit') smokeCommit();
    else if (target === 'release') smokeRelease();
    else throw new Error('usage: ci-install-smoke.mjs commit|release');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
