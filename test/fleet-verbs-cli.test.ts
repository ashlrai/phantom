import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetVerbs } from '../src/cli/fleet-verbs.js';

const deps = { verbs: ['zebra', 'alpha', 'missing'], readSource: (verb: string) => verb === 'missing' ? null : `const USAGE = 'Usage: ashlr fleet ${verb}';` };

afterEach(() => vi.restoreAllMocks());

describe('fleet verbs', () => {
  it('prints a JSON catalog including unreadable sources', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetVerbs(['--json'], deps)).toBe(0);
    const result = JSON.parse(log.mock.calls[0][0] as string);
    expect(result.schema).toBe('fleet.verbs.v1');
    expect(result.count).toBe(3);
    expect(result.verbs).toContainEqual({ verb: 'missing', usage: null, summary: null, effect: 'unknown' });
  });

  it('filters case-insensitively', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetVerbs(['--json', '--grep', 'ALPHA'], deps)).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0] as string).verbs.map((entry: { verb: string }) => entry.verb)).toEqual(['alpha']);
  });

  it('rejects unknown flags and missing grep values', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetVerbs(['--unknown'], deps)).toBe(2);
    expect(await cmdFleetVerbs(['--grep'], deps)).toBe(2);
  });

  it('answers --help and -h with usage on stdout and exit 0, never the flag parser', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const flag of ['--help', '-h']) {
      log.mockClear();
      expect(await cmdFleetVerbs([flag], deps), flag).toBe(0);
      expect(log.mock.calls.flat().join(' '), flag).toContain('Usage: ashlr fleet verbs');
    }
    // Help wins over every other flag, including --json and --grep.
    expect(await cmdFleetVerbs(['--json', '--help'], deps)).toBe(0);
    expect(await cmdFleetVerbs(['--grep', 'x', '-h'], deps)).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('reads real registered source files', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetVerbs(['--json'])).toBe(0);
    const result = JSON.parse(log.mock.calls[0][0] as string);
    for (const verb of ['landed-sweep', 'needs']) {
      const entry = result.verbs.find((item: { verb: string }) => item.verb === verb);
      expect(entry?.usage || entry?.summary).toBeTruthy();
    }
  });
});
