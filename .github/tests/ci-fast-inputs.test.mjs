/* global Buffer, process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorityHash, cleanTreeHash, policyRecords, testsHash, typecheckHashes } from '../scripts/ci-fast-inputs.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function seed(dir) {
  const files = {
    '.github/workflows/ci.yml': 'name: CI\n',
    '.github/scripts/ci-fast-inputs.mjs': 'export const marker = 1;\n',
    '.github/CODEOWNERS': '* @owners\n',
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': '{"lock":1}\n',
    'tsconfig.json': '{}\n',
    'src/web-ui/tsconfig.json': '{}\n',
    'vitest.config.ts': 'export default {};\n',
    'vitest.config.mock-compat.ts': 'export default {};\n',
    'vitest.config.web.ts': 'export default {};\n',
    'src/a.ts': 'export const a = 1;\n',
    'test/a.test.ts': 'export {};\n',
    'scripts/generate-docs-llms.mjs': 'export {};\n',
    'scripts/canonical-launcher-digests.mjs': 'export {};\n',
    'scripts/canonical-launcher-digests.json': '[]\n',
    'scripts/lib/docs-pages.mjs': 'export {};\n',
    '.github/tests/canonical-launcher-digests.test.mjs': 'export {};\n',
    'bin/ashlr': '#!/usr/bin/env node\n',
    'docs/guide.md': '# guide\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'seed');
}

test('every receipt hash includes the checker, lockfile, package, vitest and tsconfig blobs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'ci@example.invalid');
  sh(dir, 'config', 'user.name', 'ci');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  seed(dir);
  const paths = policyRecords(dir).map((line) => line.slice(line.indexOf(' ') + 1));
  for (const required of ['.github/workflows/ci.yml', '.github/scripts/ci-fast-inputs.mjs', 'package-lock.json', 'package.json', 'tsconfig.json', 'src/web-ui/tsconfig.json', 'vitest.config.ts']) {
    assert.ok(paths.includes(required), required);
  }
  const before = {
    typecheck: typecheckHashes(dir, null),
    tests: testsHash(dir, Buffer.from('{"tests":[]}')),
    authority: authorityHash(dir),
    clean: cleanTreeHash(dir),
  };
  writeFileSync(join(dir, '.github/workflows/ci.yml'), 'name: CI\n# changed\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'checker');
  const after = {
    typecheck: typecheckHashes(dir, null),
    tests: testsHash(dir, Buffer.from('{"tests":[]}')),
    authority: authorityHash(dir),
    clean: cleanTreeHash(dir),
  };
  assert.notEqual(before.typecheck.backend, after.typecheck.backend);
  assert.notEqual(before.typecheck.web, after.typecheck.web);
  assert.notEqual(before.tests, after.tests);
  assert.notEqual(before.authority, after.authority);
  assert.notEqual(before.clean, after.clean);
});

test('clean-tree receipts include canonical launcher digest inputs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-launcher-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'ci@example.invalid');
  sh(dir, 'config', 'user.name', 'ci');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  seed(dir);
  let previous = cleanTreeHash(dir);
  for (const path of [
    'bin/ashlr',
    'scripts/canonical-launcher-digests.json',
    'scripts/canonical-launcher-digests.mjs',
    '.github/tests/canonical-launcher-digests.test.mjs',
  ]) {
    writeFileSync(join(dir, path), `${path} changed\n`);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', `change ${path}`);
    const next = cleanTreeHash(dir);
    assert.notEqual(next, previous, path);
    previous = next;
  }
});

test('authority and clean-tree hashes run from a .github-only sparse tree', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-sparse-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', `file://${repoRoot}`, dir]);
  execFileSync('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', '.github']);
  execFileSync('git', ['-C', dir, 'checkout', '-q']);
  cpSync(join(repoRoot, '.github/scripts'), join(dir, '.github/scripts'), { recursive: true });
  assert.equal(existsSync(join(dir, 'test/config/realio-lane-membership.mjs')), false);
  assert.equal(existsSync(join(dir, '.github/scripts/ci-fast-inputs.mjs')), true);
  for (const command of ['authority', 'clean-tree']) {
    const result = spawnSync(process.execPath, ['.github/scripts/ci-fast-inputs.mjs', command], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    assert.match(result.stdout, /^hash=[0-9a-f]{64}$/m);
  }
});
