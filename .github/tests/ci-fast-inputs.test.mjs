import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityHash, cleanTreeHash, policyRecords, testsHash, typecheckHashes } from '../scripts/ci-fast-inputs.mjs';

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
    'scripts/lib/docs-pages.mjs': 'export {};\n',
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
