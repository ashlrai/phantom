/**
 * NO_COLOR (https://no-color.org): when set to a non-empty value, CLI output
 * carries no ANSI escapes, even from commands that color regardless of TTY.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeColors, noColorRequested } from '../src/cli/ui.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv) {
  const home = mkdtempSync(join(tmpdir(), 'phantom-no-color-')); homes.push(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath) };
  delete env.ASHLR_HOME;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...env, ...extraEnv },
  });
}

describe('noColorRequested / makeColors', () => {
  it('treats any non-empty NO_COLOR as a request, and empty or unset as none', () => {
    expect(noColorRequested({ NO_COLOR: '1' })).toBe(true);
    expect(noColorRequested({ NO_COLOR: 'false' })).toBe(true);
    expect(noColorRequested({ NO_COLOR: '' })).toBe(false);
    expect(noColorRequested({})).toBe(false);
  });

  it('NO_COLOR turns off even colorizers bound with tty=true', () => {
    expect(makeColors(true, { NO_COLOR: '1' }).red('x')).toBe('x');
    expect(makeColors(true, {}).red('x')).toBe('\x1b[31mx\x1b[0m');
    expect(makeColors(false, {}).red('x')).toBe('x');
  });
});

describe('CLI honors NO_COLOR', () => {
  it('config list prints no ANSI with NO_COLOR=1', () => {
    const result = runCli(['config', 'list'], { NO_COLOR: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ashlr config');
    expect(result.stdout).not.toContain('\u001b');
  });

  it('an unknown command reports on stderr without ANSI with NO_COLOR=1, and with color otherwise', () => {
    const plain = runCli(['definitely-not-a-command'], { NO_COLOR: '1' });
    expect(plain.status).toBe(2);
    expect(plain.stderr).toContain('Unknown command');
    expect(plain.stderr).not.toContain('\u001b');
    const colored = runCli(['definitely-not-a-command'], {});
    expect(colored.stderr).toContain('\u001b[');
  });
});
