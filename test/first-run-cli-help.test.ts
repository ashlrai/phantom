/**
 * `phm init --help` used to run init (writing config, symlinks and editor
 * files) and `phm doctor --help` ran the full doctor. Both must print usage,
 * exit 0 and leave a fresh HOME untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdDoctor, cmdInit } from '../src/cli/doctor-init.js';

const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ASHLR_HOME: process.env.ASHLR_HOME,
};
let home: string;
let logged: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phm-help-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ASHLR_HOME;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe.each([
  ['init', cmdInit, /Usage: phm init/],
  ['doctor', cmdDoctor, /Usage: phm doctor/],
] as const)('phm %s --help', (_name, cmd, usage) => {
  it.each(['--help', '-h'])('%s prints usage, exits 0 and writes nothing', async (flag) => {
    const code = await cmd([flag]);
    expect(code).toBe(0);
    expect(logged.join('\n')).toMatch(usage);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });
});
