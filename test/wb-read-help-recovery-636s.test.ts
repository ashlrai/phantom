import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWbLocus } from '../src/core/workbench/locus.js';
import { readWorkbenchSecrets } from '../src/core/workbench/secrets.js';
import { runSteerAction } from '../src/core/workbench/steer.js';
import { cmdWb } from '../src/cli/wb.js';

// Companion read boundaries and the steer action boundary are mocked: no `locus`
// or `phantom` process is launched, no live service is probed, no host custody is read.
vi.mock('../src/core/workbench/locus.js', () => ({ readWbLocus: vi.fn() }));
vi.mock('../src/core/workbench/secrets.js', () => ({ readWorkbenchSecrets: vi.fn() }));
vi.mock('../src/core/workbench/steer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/workbench/steer.js')>()),
  runSteerAction: vi.fn(),
}));

const USAGE_MARKER = 'Usage: phm wb secrets [--json]';
const READ_VERBS = ['locus', 'secrets'] as const;
const HELP_ARGS: string[][] = [
  ['--help'],
  ['-h'],
  ['--json', '--help'],
  ['--help', '--json'],
  ['--json', '-h'],
  ['-h', '--json'],
  ['--json', '--help', '--json'],
];

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function noCompanionReads(): void {
  expect(readWbLocus).not.toHaveBeenCalled();
  expect(readWorkbenchSecrets).not.toHaveBeenCalled();
  expect(runSteerAction).not.toHaveBeenCalled();
}

describe('wb read-verb help', () => {
  it.each(READ_VERBS.flatMap(verb => HELP_ARGS.map(flags => [verb, flags] as const)))(
    '%s %j prints usage, exits 0, and never reads a companion',
    async (verb, flags) => {
      expect(await cmdWb([verb, ...flags])).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toContain(USAGE_MARKER);
      expect(error).not.toHaveBeenCalled();
      noCompanionReads();
    },
  );

  it('keeps top-level help working without any reads', async () => {
    for (const args of [[], ['--help'], ['-h']]) {
      expect(await cmdWb(args)).toBe(0);
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(String(log.mock.calls[0]?.[0])).toContain(USAGE_MARKER);
    noCompanionReads();
  });

  it('refuses an invalid Locus argument with exit 2, even beside a help flag', async () => {
    expect(await cmdWb(['locus', '--bogus'])).toBe(2);
    expect(await cmdWb(['locus', '--bogus', '--help'])).toBe(2);
    expect(error).toHaveBeenCalled();
    noCompanionReads();
  });

  it('refuses other invalid read arguments with exit 2 and no reads', async () => {
    expect(await cmdWb(['secrets', '--reveal'])).toBe(2);
    expect(await cmdWb(['secrets', '--reveal', '--help'])).toBe(2);
    expect(await cmdWb(['locus', '--json', '--json'])).toBe(2);
    noCompanionReads();
  });

  it('does not treat help flags on steer as a read-verb help request', async () => {
    await cmdWb(['steer', '--text', 'note', '--help']);
    await cmdWb(['steer', '--text', '--help']);
    expect(runSteerAction).not.toHaveBeenCalled();
    expect(readWbLocus).not.toHaveBeenCalled();
    expect(readWorkbenchSecrets).not.toHaveBeenCalled();
  });
});
