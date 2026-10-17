import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdLocalRuntime } from '../src/cli/local-runtime.js';

afterEach(() => vi.restoreAllMocks());

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
});
