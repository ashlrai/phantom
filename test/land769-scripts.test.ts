import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHelpFixture, helpFixtureSnapshot, removeHelpFixture, runHelp } from './helpers/top-level-help.mjs';

let fixture: ReturnType<typeof createHelpFixture>;
beforeEach(() => { fixture = createHelpFixture(); });
afterEach(() => { vi.unstubAllEnvs(); removeHelpFixture(fixture); });

function entry(source: string): string {
  const path = join(fixture.root, 'fixture.mjs');
  writeFileSync(path, source);
  return path;
}

describe('carried top-level help subprocess helper', () => {
  it.each([0, 2])('preserves argv, stdout, stderr and exit %i without ambient environment', status => {
    vi.stubEnv('LAND769_AMBIENT_ONLY', 'must stay in parent');
    const executable = entry(`
console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME,
  cwd: process.cwd(), ambient: process.env.LAND769_AMBIENT_ONLY ?? null }));
console.error('Usage: fixture --help');
process.exitCode = ${status};
`);
    const result = runHelp(fixture, ['fixture', '--help'], { entry: executable });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['fixture', '--help'], home: fixture.home, cwd: fixture.cwd, ambient: null,
    });
    expect(result.stderr.trim()).toBe('Usage: fixture --help');
    expect(helpFixtureSnapshot(fixture)).toEqual({});
    expect(existsSync(fixture.effects)).toBe(false);
  }, 35_000);

  it.each([
    ["import { spawnSync } from 'node:child_process';", "spawnSync(process.execPath, ['--version']);"],
    ["import net from 'node:net';", "net.connect(1, '127.0.0.1');"],
    ['', "await fetch('http://127.0.0.1:1');"],
  ])('records and blocks effects even when a help entry catches the error: %s', (imports, operation) => {
    const executable = entry(`${imports}\ntry { ${operation} } catch {}\nconsole.log('Usage: fixture --help');`);
    const result = runHelp(fixture, ['--help'], { entry: executable });
    expect(result.error).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    expect(result.stdout.trim()).toBe('Usage: fixture --help');
    expect(readFileSync(fixture.effects, 'utf8')).toBe('attempt\n');
    expect(helpFixtureSnapshot(fixture)).toEqual({});
  }, 35_000);

  it('terminates a help entry that never exits and preserves its failure', () => {
    const executable = entry("console.log('Usage: fixture --help'); setInterval(() => {}, 1000);");
    const result = runHelp(fixture, ['--help'], { entry: executable, timeout: 2_000 });
    expect(result.error?.code).toBe('ETIMEDOUT');
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(result.stdout).toContain('Usage: fixture --help');
  }, 35_000);
});
