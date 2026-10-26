/**
 * First-run config portability: the config a fresh install writes must not
 * assume a macOS ~/Desktop/github layout. Roots are probed from folders that
 * exist, tidy rules are dropped when there is no ~/Desktop, and a saved config
 * is never rewritten. All filesystem probing is injected or confined to a temp
 * HOME.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfig,
  detectDefaultRoots,
  firstRunConfig,
  FALLBACK_CODE_DIRS,
  loadConfig,
  loadConfigReadOnly,
} from '../src/core/config.js';
import { planTidy } from '../src/core/tidy.js';

const HOME = '/home/tester';
const probe = (...present: string[]) => {
  const set = new Set(present.map((p) => join(HOME, p)));
  return { home: HOME, exists: (p: string) => set.has(p) };
};

describe('detectDefaultRoots', () => {
  it('keeps the classic roots exactly when ~/Desktop/github exists', () => {
    expect(detectDefaultRoots(probe('Desktop/github', 'Desktop', 'code', 'Developer')))
      .toEqual([join(HOME, 'Desktop/github'), join(HOME, 'Desktop')]);
  });

  it('falls back to existing code folders on a fresh Linux home', () => {
    expect(detectDefaultRoots(probe('projects', 'code', 'repos')))
      .toEqual([join(HOME, 'code'), join(HOME, 'projects'), join(HOME, 'repos')]);
  });

  it('puts ~/Desktop before code folders so tidy never targets a code folder', () => {
    expect(detectDefaultRoots(probe('Desktop', 'Developer')))
      .toEqual([join(HOME, 'Desktop'), join(HOME, 'Developer')]);
  });

  it('returns no roots when nothing exists instead of listing missing folders', () => {
    expect(detectDefaultRoots(probe())).toEqual([]);
  });

  it('never probes ~/github (the index treats it as a category container)', () => {
    expect(FALLBACK_CODE_DIRS).not.toContain('github');
    expect(detectDefaultRoots(probe('github'))).toEqual([]);
  });

  it('probes in a fixed, documented order', () => {
    const all = probe(...FALLBACK_CODE_DIRS);
    expect(detectDefaultRoots(all)).toEqual(FALLBACK_CODE_DIRS.map((d) => join(HOME, d)));
  });
});

describe('firstRunConfig', () => {
  it('keeps default tidy rules when ~/Desktop exists', () => {
    const cfg = firstRunConfig(probe('Desktop'));
    expect(cfg.tidyRules).toEqual(defaultConfig().tidyRules);
    expect(cfg.tidyRules.length).toBeGreaterThan(0);
  });

  it('drops tidy rules when there is no ~/Desktop to tidy', () => {
    const cfg = firstRunConfig(probe('code'));
    expect(cfg.tidyRules).toEqual([]);
    expect(cfg.roots).toEqual([join(HOME, 'code')]);
  });

  it('leaves every other default untouched and defaultConfig() pure', () => {
    const cfg = firstRunConfig(probe('code'));
    const base = defaultConfig();
    expect({ ...cfg, roots: base.roots, tidyRules: base.tidyRules }).toEqual(base);
    expect(base.roots).toEqual([join(base.roots[1]!, 'github'), base.roots[1]]);
  });

  it('ships no personal paths', () => {
    expect(JSON.stringify(firstRunConfig(probe('code')))).not.toMatch(/masonwyatt|\/Users\/you/);
  });
});

describe('first-run write under a fresh HOME', () => {
  let home = '';
  let savedHome: string | undefined;

  const withHome = <T>(fn: () => T): T => {
    savedHome = process.env.HOME;
    process.env.HOME = home;
    try { return fn(); } finally { process.env.HOME = savedHome; }
  };

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  it('writes probed roots and no tidy rules on a Linux-style home', () => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-first-run-'));
    mkdirSync(join(home, 'code'));
    const cfg = withHome(() => loadConfig());
    expect(cfg.roots).toEqual([join(home, 'code')]);
    expect(cfg.tidyRules).toEqual([]);
    const saved = JSON.parse(readFileSync(join(home, '.ashlr', 'config.json'), 'utf8'));
    expect(saved.roots).toEqual([join(home, 'code')]);
    expect(saved.tidyRules).toEqual([]);
    // tidy has nothing to propose and no Desktop folders get created.
    expect(planTidy(cfg).moves).toEqual([]);
    expect(existsSync(join(home, 'Desktop'))).toBe(false);
  });

  it('read-only load of a missing config reports the probed roots without writing', () => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-first-run-'));
    mkdirSync(join(home, 'projects'));
    const cfg = withHome(() => loadConfigReadOnly());
    expect(cfg.roots).toEqual([join(home, 'projects')]);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it('never rewrites roots in an existing saved config', () => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-first-run-'));
    mkdirSync(join(home, 'code'));
    mkdirSync(join(home, '.ashlr'));
    const custom = ['/srv/my-repos'];
    writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({ version: 1, roots: custom }));
    const cfg = withHome(() => loadConfig());
    expect(cfg.roots).toEqual(custom);
    const saved = JSON.parse(readFileSync(join(home, '.ashlr', 'config.json'), 'utf8'));
    expect(saved.roots).toEqual(custom);
  });
});
