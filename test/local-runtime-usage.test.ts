import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdLocalRuntime } from '../src/cli/local-runtime.js';

const tempHomes: string[] = [];
const originalHome = process.env['HOME'];

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ashlr local-runtime usage', () => {
  it('lists every subcommand it documents, reshape included, on the usage line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLocalRuntime(['--help'])).toBe(0);
    const usage = String(log.mock.calls[0]?.[0] ?? '');
    const first = usage.split('\n')[0] ?? '';
    const listed = /<([^>]+)>/.exec(first)?.[1]?.split('|') ?? [];
    const documented = [...usage.matchAll(/^ {2}([a-z][a-z-]+)\s/gm)].map((match) => match[1]);
    expect(documented).toContain('reshape');
    expect(listed).toEqual(documented);
  });

  it('rejects missing values on --model and --model-path', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdLocalRuntime(['status', '--model'])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0] ?? '')).toContain('--model expects a value');
    expect(await cmdLocalRuntime(['status', '--model-path', '--json'])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0] ?? '')).toContain('--model-path expects a value');
  });

  it('refuses install in JSON mode with plistPath while KILL is engaged', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-local-runtime-cli-'));
    tempHomes.push(home);
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'KILL'), '1\n');
    process.env['HOME'] = home;

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLocalRuntime(['install', '--json'])).toBe(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0] ?? '{}')) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['action']).toBe('refused');
    expect(String(parsed['detail'])).toContain('kill switch');
    expect(String(parsed['plistPath'])).toContain('ai.ashlr.local-runtime.plist');
  });
});
