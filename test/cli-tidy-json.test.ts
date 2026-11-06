/**
 * CLI contract test: `ashlr tidy --json`
 *
 * The Raycast "Tidy Desktop" command spawns `ashlr tidy --json` and JSON.parses
 * stdout. This test asserts that stdout is ONLY a parseable TidyPlan
 * ({ moves, skipped }) with zero color/log noise — the contract the Raycast
 * layer depends on.
 *
 * The test runs the COMPILED CLI (dist/cli/index.js), so it requires a prior
 * `npm run build` (CONTRIBUTING.md). It never builds dist/ itself: a lazy
 * in-suite build rewrites the shared dist/ while sibling files in the parallel
 * unit lane spawn or hash it, which made those files fail and then pass on a
 * re-run. It points HOME at a temp dir so it never touches the real
 * ~/.ashlr or the real Desktop.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { TidyPlan } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');

describe('CLI: ashlr tidy --json', () => {
  let home: string;
  let desktop: string;

  function runTidy(...args: string[]) {
    const result = spawnSync(process.execPath, [cliEntry, 'tidy', '--json', ...args], {
      encoding: 'utf8',
      cwd: home,
      // Native homedir() uses USERPROFILE on Windows. Keep application state
      // in the same fixture even when the parent supplies ASHLR_HOME.
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1', FORCE_COLOR: '0',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  beforeAll(() => {
    // Fail fast instead of building: see the header for why tests must not
    // write the shared dist/ concurrently with the files that read it.
    if (!existsSync(cliEntry)) {
      throw new Error(`${cliEntry} is missing; run \`npm run build\` before this suite`);
    }
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-cli-home-'));
    desktop = join(home, 'Desktop');
    mkdirSync(desktop, { recursive: true });

    // A loose PDF that should be planned for a move.
    writeFileSync(join(desktop, 'invoice.pdf'), 'dummy');
    mkdirSync(join(desktop, 'Business'), { recursive: true });

    // Write a config so tidy has a deterministic root + rule (no real Desktop).
    const cfg = {
      version: 1,
      roots: [desktop],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [
        { match: '.pdf', matchType: 'ext', dest: join(desktop, 'Business') },
      ],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
    };
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify(cfg, null, 2));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('emits ONLY a parseable TidyPlan on stdout', () => {
    const raw = runTidy().trim();
    // stdout must be valid JSON with no leading log chatter.
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(raw); }).not.toThrow();

    const plan = parsed as TidyPlan;
    expect(Array.isArray(plan.moves)).toBe(true);
    expect(Array.isArray(plan.skipped)).toBe(true);

    // Our loose invoice.pdf should be in the planned moves.
    expect(plan.moves).toEqual([{
      from: join(desktop, 'invoice.pdf'),
      to: join(desktop, 'Business', 'invoice.pdf'),
      rule: expect.any(String),
    }]);
    expect(existsSync(join(desktop, 'invoice.pdf'))).toBe(true);
    expect(existsSync(join(desktop, 'Business', 'invoice.pdf'))).toBe(false);
  });

  it('does not contain ANSI escape codes in stdout', () => {
    const raw = runTidy();
    // No ESC (\x1b) control characters.
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(raw)).toBe(false);
  });

  it('applies the move and emits only the post-apply JSON plan', () => {
    const plan = JSON.parse(runTidy('--apply')) as TidyPlan;
    expect(plan.moves).toEqual([]);
    expect(Array.isArray(plan.skipped)).toBe(true);
    expect(existsSync(join(desktop, 'invoice.pdf'))).toBe(false);
    expect(existsSync(join(desktop, 'Business', 'invoice.pdf'))).toBe(true);
  });
});
