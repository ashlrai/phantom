#!/usr/bin/env node
/* global process, console */
// Regenerates the generated owner-lane block of .github/CODEOWNERS.
//
// Run this when test/authority-codeowners-310b.test.ts reports CODEOWNERS
// drift, which happens when a branch adds a test file that the authority
// owner lane protects (for example a new test importing a Tier-1 module under
// src/core/authority or src/core/sandbox) without listing it in CODEOWNERS.
//
//   node scripts/regenerate-codeowners.mjs
//   git add .github/CODEOWNERS && git commit -m "chore: regenerate CODEOWNERS"
//
// It runs the same generator the test pins (renderCodeownersBlock), so the
// result is byte for byte what CI expects. CODEOWNERS is itself an owner-lane
// path: the regenerated file still needs the code owner's review on GitHub.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

const before = git('status', '--porcelain', '--', '.github/CODEOWNERS').stdout;
const run = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'test/authority-codeowners-310b.test.ts'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ASHLR_UPDATE_CODEOWNERS: '1' } },
);
if (run.status !== 0) {
  console.error('regenerate-codeowners: the generator run failed; .github/CODEOWNERS may be unchanged.');
  process.exit(run.status ?? 1);
}
const after = git('status', '--porcelain', '--', '.github/CODEOWNERS').stdout;
const diff = git('diff', '--stat', '--', '.github/CODEOWNERS').stdout.trim();
if (!diff && before === after) {
  console.log('regenerate-codeowners: .github/CODEOWNERS already up to date; nothing to commit.');
} else {
  console.log('regenerate-codeowners: updated .github/CODEOWNERS\n' + diff);
  console.log('Next: git add .github/CODEOWNERS && git commit -m "chore: regenerate CODEOWNERS"');
}
