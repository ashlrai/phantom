import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireSlot, parseArgs, selectProjects, slotState, seedDecision, verdictLine } from '../scripts/typecheck-fast.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn(), spawn: vi.fn() }));

describe('fast typecheck helpers', () => {
  it('parses defaults, overrides and rejects invalid arguments', () => {
    vi.stubEnv('PHANTOM_TSC_SLOTS', '2');
    try {
      expect(parseArgs([])).toMatchObject({ slots: 2, waitSeconds: 600, timeoutSeconds: 900, seed: true });
      expect(parseArgs(['--project', 'all', '--slots', '3', '--wait-seconds', '0', '--timeout-seconds', '2', '--no-seed', '--json', '--help'])).toEqual({ project: 'all', slots: 3, waitSeconds: 0, timeoutSeconds: 2, seed: false, json: true, help: true });
      for (const args of [['--project', 'bad'], ['--slots', '0'], ['--slots'], ['--wait-seconds', '-1'], ['--timeout-seconds', 'NaN'], ['--wat']]) expect(() => parseArgs(args)).toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it('includes backend by default and web for deleted or changed web paths', () => {
    expect(selectProjects([])).toEqual(['backend']);
    expect(selectProjects(['src/web-ui/deleted.tsx'])).toEqual(['backend', 'web']);
    expect(selectProjects(['src/web-ui-other/a.ts'])).toEqual(['backend']);
    expect(selectProjects([], 'all')).toEqual(['backend', 'web']);
    expect(selectProjects([], 'web')).toEqual(['web']);
    expect(selectProjects(['src/web-ui/a.ts'], 'backend')).toEqual(['backend']);
  });

  it('classifies slots and seeds on missing or older local caches', () => {
    expect(slotState({ pidAlive: null, ageMs: 0, now: 0 })).toBe('free');
    expect(slotState({ pidAlive: true, ageMs: 0, now: 0 })).toBe('held');
    expect(slotState({ pidAlive: false, ageMs: 0, now: 0 })).toBe('stale');
    expect(slotState({ pidAlive: true, ageMs: 2400001, now: 0 })).toBe('stale');
    expect(seedDecision({})).toBe('none');
    expect(seedDecision({ sharedMtimeMs: 1 })).toBe('copy-in');
    expect(seedDecision({ localMtimeMs: 1, sharedMtimeMs: 2 })).toBe('copy-in');
    expect(seedDecision({ localMtimeMs: 2, sharedMtimeMs: 2 })).toBe('keep');
    expect(seedDecision({ localMtimeMs: 3, sharedMtimeMs: 2 })).toBe('keep');
    expect(seedDecision({ localMtimeMs: 1 })).toBe('keep');
  });

  it('formats every terminal verdict exactly', () => {
    expect(verdictLine({ project: 'backend', status: 'PASS', seconds: 2, cache: 'cold' })).toBe('PASS typecheck backend in 2s (cache cold)');
    expect(verdictLine({ project: 'web', status: 'FAIL', seconds: 1, cache: 'warm', errors: 3 })).toBe('FAIL typecheck web: 3 error(s) in 1s (cache warm)');
    expect(verdictLine({ project: 'web', status: 'TIMEOUT', seconds: 9 })).toBe('TIMEOUT typecheck web after 9s');
    expect(verdictLine({ status: 'DEFER', slots: 4 })).toBe('DEFER typecheck: 4 typechecks already running on this host; Merge Gate runs the full check');
  });

  it('acquires and releases real mkdir slots, respects EEXIST and reclaims stale owners', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'phantom-tsc-'));
    const slot = resolve(dir, 'phantom-tsc-slots/slot-0');
    try {
      const release = acquireSlot(dir, 1);
      expect(release).toBeTypeOf('function');
      expect(acquireSlot(dir, 1)).toBeNull();
      release!();
      expect(existsSync(slot)).toBe(false);
      mkdirSync(slot);
      writeFileSync(resolve(slot, 'owner'), `${process.pid} ${new Date(Date.now() - 2400001).toISOString()}`);
      const reclaimed = acquireSlot(dir, 1);
      expect(reclaimed).toBeTypeOf('function');
      reclaimed!();
      expect(existsSync(slot)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
