/**
 * `ashlr mirror` argument handling.
 *
 * The usage line is `ashlr mirror [list] [--json]`, but `ashlr mirror --json`
 * failed with "unknown mirror command: --json" (exit 2) because the first
 * argument was always taken as the verb. And `--help` after a verb, such as
 * `ashlr mirror sync --help`, failed with "unknown option --help" (exit 2).
 * A leading option now means the default `list`, and `--help` / `-h` anywhere
 * prints usage and exits 0 without touching any mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listMirrors,
  ensureMirror,
  removeMirror,
  reconcileAutonomousEnrollment,
  releaseAutonomousEnrollment,
} = vi.hoisted(() => ({
  listMirrors: vi.fn(() => [] as unknown[]),
  ensureMirror: vi.fn(),
  removeMirror: vi.fn(),
  reconcileAutonomousEnrollment: vi.fn(),
  releaseAutonomousEnrollment: vi.fn(),
}));

vi.mock('../src/core/fleet/mirrors.js', () => ({
  listMirrors,
  ensureMirror,
  removeMirror,
  reconcileAutonomousEnrollment,
  releaseAutonomousEnrollment,
  parseNameWithOwner: (value: unknown) => {
    if (typeof value !== 'string') return null;
    const [owner, name] = value.split('/');
    return owner && name ? { owner, name } : null;
  },
  mirrorPathFor: (name: string) => `/mirrors/${name}`,
}));

import { runMirrorCli } from '../src/cli/mirror.js';

let out: string;
let err: string;

beforeEach(() => {
  out = '';
  err = '';
  vi.clearAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ashlr mirror arguments', () => {
  it('`mirror --json` lists mirrors as JSON, like `mirror list --json`', async () => {
    expect(await runMirrorCli(['--json'])).toBe(0);
    expect(err).toBe('');
    expect(JSON.parse(out)).toEqual([]);
    expect(listMirrors).toHaveBeenCalledTimes(1);
  });

  it.each([
    [['--help']],
    [['-h']],
    [['help']],
    [['sync', '--help']],
    [['add', 'ashlrai/phantom', '-h']],
    [['remove', 'ashlrai/phantom', '--force', '--help']],
    [['release', '--apply', '--help']],
  ])('%j prints usage, exits 0 and changes nothing', async (args) => {
    expect(await runMirrorCli(args)).toBe(0);
    expect(out).toContain('Usage: ashlr mirror');
    expect(err).toBe('');
    for (const fn of [listMirrors, ensureMirror, removeMirror, reconcileAutonomousEnrollment, releaseAutonomousEnrollment]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('still refuses unknown options and verbs with exit 2', async () => {
    expect(await runMirrorCli(['--bogus'])).toBe(2);
    expect(err).toContain('unknown option --bogus');
    expect(await runMirrorCli(['frobnicate'])).toBe(2);
    expect(err).toContain('unknown mirror command: frobnicate');
    expect(listMirrors).not.toHaveBeenCalled();
  });
});
