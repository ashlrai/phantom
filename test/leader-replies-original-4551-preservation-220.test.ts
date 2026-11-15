/**
 * Preservation of PR #4551 (RQ-REPLYCLIN9SQ8): `phm leader replies --file`
 * resolution order — explicit --file, then PHANTOM_PLAN_LOG, then the
 * ASHLR_RUNS_DIR default — with newest-first output, --limit, exclusion of
 * undated and non-reply sections, an explanatory missing-file result, and
 * `replies sync --file` refused before any thread write. Temp files and a
 * temp HOME only; nothing reads or sends through the real home.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTmpHome } from './helpers/leader-310b-fakes.js';
import { runLeaderCli } from '../src/cli/leader.js';
import { leaderRoot } from '../src/core/vision/leader-memo.js';
import { leaderThreadPath } from '../src/core/vision/leader-thread.js';

const home = useTmpHome();
let world: string;
let runsDir: string;
let envFile: string;
let fileFile: string;
let absentFile: string;

const writePlan = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

const reply = (at: string, text: string): string => `## ${at} ET\n**Reply for Mason**\n${text}`;

interface RepliesResult {
  sourceState: string;
  entries: { at: string; text: string }[];
  reason?: string;
}

const lastJson = (log: { mock: { calls: unknown[][] } }): RepliesResult =>
  JSON.parse(String(log.mock.calls.at(-1)![0])) as RepliesResult;

beforeEach(() => {
  home.setup();
  world = mkdtempSync(join(tmpdir(), 'leader-replies-4551-'));
  runsDir = join(world, 'runs');
  envFile = join(world, 'env-plan-log.md');
  fileFile = join(world, 'explicit-plan-log.md');
  absentFile = join(world, 'absent-plan-log.md');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(world, { recursive: true, force: true });
  home.teardown();
});

describe('leader replies original PR #4551 preservation', () => {
  it('explicit --file beats PHANTOM_PLAN_LOG, which beats the ASHLR_RUNS_DIR default; newest first, --limit honoured, undated and non-reply sections excluded', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
    writePlan(join(runsDir, 'leader', 'PLAN-LOG.md'), reply('2026-11-05 09:00', 'Runs-dir default answer'));
    writePlan(envFile, reply('2026-11-06 09:00', 'Env plan-log answer'));
    writePlan(fileFile, [
      reply('2026-11-04 09:00', 'Explicit older answer'),
      reply('2026-11-07 09:00', 'Explicit newest answer'),
      '## 2026-11-08 09:00 ET\nA dated section with planning notes and no reply marker',
      '## Undated section\n**Reply for Mason**\nUndated answer must not appear',
    ].join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runLeaderCli(['replies', '--json'])).toBe(0);
      expect(lastJson(log).entries.map(e => e.text)).toEqual(['Runs-dir default answer']);
      vi.stubEnv('PHANTOM_PLAN_LOG', envFile);
      expect(await runLeaderCli(['replies', '--json'])).toBe(0);
      expect(lastJson(log).entries.map(e => e.text)).toEqual(['Env plan-log answer']);
      expect(await runLeaderCli(['replies', '--json', '--file', fileFile])).toBe(0);
      const result = lastJson(log);
      expect(result.sourceState).toBe('healthy');
      expect(result.entries.map(e => [e.at, e.text])).toEqual([
        ['2026-11-07 09:00', 'Explicit newest answer'],
        ['2026-11-04 09:00', 'Explicit older answer'],
      ]);
      expect(await runLeaderCli(['replies', '--json', '--limit', '1', '--file', fileFile])).toBe(0);
      expect(lastJson(log).entries.map(e => e.text)).toEqual(['Explicit newest answer']);
    } finally { log.mockRestore(); }
  }, 30_000);

  it('a missing --file explains the absent PLAN-LOG in JSON and plain output', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runLeaderCli(['replies', '--json', '--file', absentFile])).toBe(0);
      const result = lastJson(log);
      expect(result.sourceState).toBe('missing');
      expect(result.entries).toEqual([]);
      expect(result.reason).toContain(`No PLAN-LOG file at ${absentFile}`);
      expect(await runLeaderCli(['replies', '--file', absentFile])).toBe(0);
      expect(String(log.mock.calls.at(-1)![0])).toContain('No PLAN-LOG file at');
    } finally { log.mockRestore(); }
  }, 30_000);

  it('replies sync --file is rejected with usage before any thread write even when plan logs hold replies', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.stubEnv('PHANTOM_PLAN_LOG', envFile);
    writePlan(join(runsDir, 'leader', 'PLAN-LOG.md'), reply('2026-11-05 09:00', 'Runs-dir default answer'));
    writePlan(envFile, reply('2026-11-06 09:00', 'Env plan-log answer'));
    writePlan(fileFile, reply('2026-11-07 09:00', 'Explicit answer'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runLeaderCli(['replies', 'sync', '--file', fileFile])).toBe(2);
      expect(String(err.mock.calls.at(-1)![0])).toContain('leader replies');
      expect(log).not.toHaveBeenCalled();
      expect(existsSync(leaderThreadPath())).toBe(false);
      expect(existsSync(join(leaderRoot(), 'thread-index.json'))).toBe(false);
    } finally { log.mockRestore(); err.mockRestore(); }
  }, 30_000);
});
