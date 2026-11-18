#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'scripts/canonical-launcher-digests.json');

export function launcherSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertLauncherDigestListed(bytes, digests) {
  if (!Array.isArray(digests) || digests.some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) ||
    new Set(digests).size !== digests.length) {
    throw new Error('canonical launcher digest list is invalid');
  }
  const digest = launcherSha256(bytes);
  if (!digests.includes(digest)) throw new Error(`current launcher digest ${digest} is missing from the canonical launcher digest list`);
  return digest;
}

function historyDigests() {
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true') {
    throw new Error('full git history is required to regenerate canonical launcher digests');
  }
  const commits = execFileSync('git', ['log', '--format=%H', '--', 'bin/ashlr'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (!commits.length) throw new Error('git history has no bin/ashlr entries');
  return [...new Set(commits.map((commit) => launcherSha256(execFileSync('git', ['show', `${commit}:bin/ashlr`], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  }))))].sort();
}

function readDigests() {
  const digests = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(digests) || digests.some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) ||
    new Set(digests).size !== digests.length) {
    throw new Error('canonical launcher digest list is invalid');
  }
  return digests;
}

function checkCurrent() {
  const digest = assertLauncherDigestListed(readFileSync(join(root, 'bin/ashlr')), readDigests());
  console.log(`canonical launcher digest check passed: ${digest}`);
}

function writeHistory() {
  const digests = historyDigests();
  writeFileSync(manifestPath, `${JSON.stringify(digests, null, 2)}\n`);
  console.log(`wrote ${digests.length} canonical launcher digests`);
}

function checkHistory() {
  const actual = readDigests();
  const expected = historyDigests();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('canonical launcher digest list differs from bin/ashlr history; run npm run canonical-launcher-digests:regen');
  }
  checkCurrent();
}

function main() {
  const command = process.argv[2] ?? '--check';
  if (command === '--write') writeHistory();
  else if (command === '--check') checkCurrent();
  else if (command === '--check-history') checkHistory();
  else throw new Error('usage: canonical-launcher-digests.mjs [--check|--check-history|--write]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
