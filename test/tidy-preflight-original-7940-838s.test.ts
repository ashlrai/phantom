import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { requireBuiltDist } from './helpers/require-built-dist.js';

const roots: string[] = [];
const artifact = 'dist/cli/index.js';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tidy-preflight-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('original tidy preflight preservation', () => {
  it('fails with a build instruction without creating dist', () => {
    const root = temporaryRoot();
    expect(() => requireBuiltDist([artifact], root)).toThrow('missing dist/cli/index.js; run npm run build first');
    expect(existsSync(join(root, 'dist'))).toBe(false);
  });

  it('uses the explicit root independently of cwd', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(root, artifact), '');
    const other = temporaryRoot();
    const previous = process.cwd();
    try {
      process.chdir(other);
      expect(() => requireBuiltDist([artifact], root)).not.toThrow();
    } finally {
      process.chdir(previous);
    }
  });

  it('rejects an unrelated dist file', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'unrelated.js'), '');
    expect(() => requireBuiltDist([artifact], root)).toThrow('missing dist/cli/index.js; run npm run build first');
  });

  it('wires the tidy suite to the shared explicit-root preflight', () => {
    const source = readFileSync(join(repoRoot, 'test/cli-tidy-json.test.ts'), 'utf8');
    expect(source).toMatch(/import\s*\{\s*requireBuiltDist\s*\}\s*from\s*['"]\.\/helpers\/require-built-dist\.js['"]/);
    expect(source).toMatch(/requireBuiltDist\(\s*\[\s*['"]dist\/cli\/index\.js['"]\s*\]\s*,\s*repoRoot\s*\)/);
    expect(source).not.toMatch(/(?:execSync|execFileSync|spawnSync|exec|execFile|spawn)\s*\([^\n]*(?:npm run build|['"]npm['"]\s*,\s*\[\s*['"]run['"]\s*,\s*['"]build['"])/);
  });
});
