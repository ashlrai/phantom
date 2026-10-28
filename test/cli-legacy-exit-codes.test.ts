import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const commands = ['index', 'go', 'status', 'ls', 'open', 'tidy'];

describe('legacy command exit codes', () => {
  it.each(commands.flatMap((command) => [
    [command, '--help', 0],
    [command, '-h', 0],
    [command, '--not-a-valid-option', 2],
  ] as const))('%s %s exits %i before accessing the home', (command, arg, expected) => {
    const home = mkdtempSync(join(tmpdir(), 'phm-exit-codes-'));
    try {
      const result = spawnSync(process.execPath, ['--import', loader, entry, command, arg], {
        cwd: home,
        env: { PATH: process.env['PATH'], HOME: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(expected);
      expect(result.stdout + result.stderr).toContain('Usage:');
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['index', ['unexpected']],
    ['status', ['unexpected']],
    ['ls', ['one', 'two']],
    ['tidy', ['unexpected']],
  ])('%s rejects extra operands', (command, args) => {
    const home = mkdtempSync(join(tmpdir(), 'phm-exit-codes-'));
    try {
      const result = spawnSync(process.execPath, ['--import', loader, entry, command, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'], HOME: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('Usage:');
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
