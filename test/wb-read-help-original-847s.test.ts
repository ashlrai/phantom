import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWbLocus } from '../src/core/workbench/locus.js';
import { readWorkbenchSecrets } from '../src/core/workbench/secrets.js';
import { cmdWb } from '../src/cli/wb.js';

vi.mock('../src/core/workbench/locus.js', () => ({ readWbLocus: vi.fn() }));
vi.mock('../src/core/workbench/secrets.js', () => ({ readWorkbenchSecrets: vi.fn() }));

const verbs = ['locus', 'secrets'] as const;
const flags = [['--help'], ['-h'], ['--help', '--json'], ['--json', '--help'], ['-h', '--json'], ['--json', '-h']];
const usage = 'Usage: phm wb secrets [--json]';
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function expectNoReads(): void {
  expect(readWbLocus).not.toHaveBeenCalled();
  expect(readWorkbenchSecrets).not.toHaveBeenCalled();
}

describe('original workbench read help preservation', () => {
  it.each(verbs.flatMap(verb => flags.map(args => [verb, args] as const)))(
    '%s %j prints usage offline', async (verb, args) => {
      expect(await cmdWb([verb, ...args])).toBe(0);
      expect(log).toHaveBeenCalledOnce();
      expect(String(log.mock.calls[0]?.[0])).toContain(usage);
      expect(String(log.mock.calls[0]?.[0])).toContain('phm wb locus [--json]');
      expect(error).not.toHaveBeenCalled();
      expectNoReads();
    },
  );
  it.each(verbs.flatMap(verb => [['--bogus', '--help'], ['-h', '--bogus']].map(args => [verb, args] as const)))(
    '%s %j refuses unsupported arguments offline', async (verb, args) => {
      expect(await cmdWb([verb, ...args])).toBe(2);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]?.[0])).toContain(usage);
      expect(log).not.toHaveBeenCalled();
      expectNoReads();
    },
  );
});
