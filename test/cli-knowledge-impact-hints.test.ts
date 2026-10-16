/**
 * `ashlr knowledge` help and errors only name commands that exist.
 *
 * The knowledge help advertised a top-level alias, `ashlr impact <target>`,
 * and the impact usage error said "Run `ashlr impact --help`". The dispatcher
 * has no `impact` command, so following either hint failed with
 * "Unknown command: impact" (exit 2). The subcommand is
 * `ashlr knowledge impact`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdKnowledge } from '../src/cli/knowledge.js';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';

let out: string;
let err: string;

beforeEach(() => {
  out = '';
  err = '';
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

/** Every `ashlr <command>` the text tells the user to run. */
function namedCommands(text: string): string[] {
  return [...text.matchAll(/\bashlr ([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
}

describe('knowledge impact hints', () => {
  it.each([
    [['--help']],
    [['impact', '--help']],
  ])('help for %j names only real commands', async (args) => {
    expect(await cmdKnowledge(args)).toBe(0);
    expect(out).toContain('ashlr knowledge impact');
    expect(out).not.toMatch(/ashlr impact\b/);
    for (const cmd of namedCommands(out)) expect(TOP_LEVEL_COMMANDS, `ashlr ${cmd}`).toContain(cmd);
  });

  it('a missing target points at `ashlr knowledge impact --help` and exits 2', async () => {
    expect(await cmdKnowledge(['impact'])).toBe(2);
    expect(err).toContain('Run `ashlr knowledge impact --help` for usage.');
    expect(err).not.toMatch(/ashlr impact\b/);
    for (const cmd of namedCommands(err)) expect(TOP_LEVEL_COMMANDS, `ashlr ${cmd}`).toContain(cmd);
  });

  it('there is no top-level `impact` command to alias', () => {
    expect(TOP_LEVEL_COMMANDS).not.toContain('impact');
  });
});
