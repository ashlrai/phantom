/**
 * Regression: `config set --help` and `config set -h` must exit 0 and print
 * the usage line to stdout.  `config set editor --help` must stay exit 2.
 *
 * See test/cli-help-no-side-effects.test.ts for the comprehensive --help
 * contract that covers 600+ commands; this file is a focused, fast guard
 * around the specific CLI dispatcher bug fixed in src/cli/index.ts.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Replicate the existing test's CLI entry: use dist/ when fresh, otherwise
// source through tsx via --import.  This keeps the test accurate for both
// edited-and-unbuilt and built states.
function distIsFresh(): boolean {
  if (!existsSync(join(ROOT, 'dist', 'cli', 'index.js'))) return false;
  const srcRoot = join(ROOT, 'src');
  const skip = new Set([join(srcRoot, 'raycast'), join(srcRoot, 'web-ui')]);
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(full) && !walk(full)) return false;
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const built = join(ROOT, 'dist', relative(srcRoot, full)).replace(/\.ts$/, '.js');
        if (!existsSync(built) || statSync(built).mtimeMs < statSync(full).mtimeMs) return false;
      }
    }
    return true;
  };
  return walk(srcRoot);
}

const USE_DIST = distIsFresh();
const ENTRY_ARGS: string[] = USE_DIST
  ? [join(ROOT, 'dist', 'cli', 'index.js')]
  : [
      '--import',
      pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      join(ROOT, 'src', 'cli', 'index.ts'),
    ];

function run(argv: string[]): ReturnType<typeof spawnSync> {
  const home = mkdtempSync(join(tmpdir(), 'config-set-help-'));
  return spawnSync(process.execPath, [...ENTRY_ARGS, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      ASHLR_HOME: join(home, '.ashlr'),
      NO_COLOR: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
}

describe('config set --help exit code', () => {
  it('config set --help exits 0 and prints the usage line to stdout', () => {
    const out = run(['config', 'set', '--help']);
    expect(out.status, `stderr: ${String(out.stderr)}`).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('Usage: ashlr config set <key> <value>');
  });

  it('config set -h exits 0 and prints the usage line to stdout', () => {
    const out = run(['config', 'set', '-h']);
    expect(out.status, `stderr: ${String(out.stderr)}`).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('Usage: ashlr config set <key> <value>');
  });

  it('config set editor --help still exits 2', () => {
    const out = run(['config', 'set', 'editor', '--help']);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('Usage: ashlr config set <key> <value>');
  });
});
