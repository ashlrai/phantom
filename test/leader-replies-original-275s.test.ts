/**
 * Executable preservation evidence for PR #4551 (RQ-REPLYCLIN9SQ8,
 * head 7d71f1215a39c8a15cd75746e2823a069a4042f0): the Leader replies CLI
 * resolves its PLAN-LOG as explicit --file, then PHANTOM_PLAN_LOG, then
 * ASHLR_RUNS_DIR/leader/PLAN-LOG.md; prints newest-first; skips dated
 * sections without a reply marker; reports a missing source with a reason;
 * and inspecting replies writes no thread message or inbox item. Also pins
 * master's later per-date dedupe: identical reply text survives on different
 * dates but collapses to the newest copy within one date. Temp files and a
 * temp HOME only; the implementation under test is never mocked.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTmpHome } from './helpers/leader-310b-fakes.js';
import { runLeaderCli } from '../src/cli/leader.js';
import { readPlanLogReplies } from '../src/core/fleet/mason-outbox.js';
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
  world = mkdtempSync(join(tmpdir(), 'leader-replies-275s-'));
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

describe('leader replies original PR #4551 reconciliation (275s)', () => {
  it('explicit --file beats PHANTOM_PLAN_LOG, which beats the runs-dir PLAN-LOG; each selection is exact', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.stubEnv('PHANTOM_PLAN_LOG', envFile);
    writePlan(join(runsDir, 'leader', 'PLAN-LOG.md'), reply('2026-11-05 09:00', 'RUNS-DIR-ONLY-REPLY'));
    writePlan(envFile, reply('2026-11-06 09:00', 'ENV-ONLY-REPLY'));
    writePlan(fileFile, reply('2026-11-07 09:00', 'EXPLICIT-ONLY-REPLY'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runLeaderCli(['replies', '--json', '--file', fileFile])).toBe(0);
      let result = lastJson(log);
      expect(result.sourceState).toBe('healthy');
      expect(result.entries.map(e => e.text)).toEqual(['EXPLICIT-ONLY-REPLY']);
      let raw = String(log.mock.calls.at(-1)![0]);
      expect(raw).not.toContain('ENV-ONLY-REPLY');
      expect(raw).not.toContain('RUNS-DIR-ONLY-REPLY');

      expect(await runLeaderCli(['replies', '--json'])).toBe(0);
      result = lastJson(log);
      expect(result.entries.map(e => e.text)).toEqual(['ENV-ONLY-REPLY']);
      raw = String(log.mock.calls.at(-1)![0]);
      expect(raw).not.toContain('EXPLICIT-ONLY-REPLY');
      expect(raw).not.toContain('RUNS-DIR-ONLY-REPLY');

      vi.stubEnv('PHANTOM_PLAN_LOG', '');
      expect(await runLeaderCli(['replies', '--json'])).toBe(0);
      result = lastJson(log);
      expect(result.entries.map(e => e.text)).toEqual(['RUNS-DIR-ONLY-REPLY']);
      raw = String(log.mock.calls.at(-1)![0]);
      expect(raw).not.toContain('ENV-ONLY-REPLY');
      expect(raw).not.toContain('EXPLICIT-ONLY-REPLY');
    } finally { log.mockRestore(); }
  }, 30_000);

  it('prints newest-first, skips dated sections without a reply, and never writes a thread message or inbox item', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
    writePlan(join(runsDir, 'leader', 'PLAN-LOG.md'), [
      reply('2026-11-04 09:00', 'Older answer'),
      '## 2026-11-05 09:00 ET\nPlanning notes with no reply marker\n- unrelated bullet',
      reply('2026-11-06 09:00', 'Newest answer'),
      '## Undated heading\n**Reply for Mason**\nUndated answer excluded',
    ].join('\n'));
    const before = readdirSync(join(runsDir, 'leader')).sort();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runLeaderCli(['replies', '--json'])).toBe(0);
      const result = lastJson(log);
      expect(result.entries.map(e => [e.at, e.text])).toEqual([
        ['2026-11-06 09:00', 'Newest answer'],
        ['2026-11-04 09:00', 'Older answer'],
      ]);
      expect(await runLeaderCli(['replies'])).toBe(0);
      const plain = String(log.mock.calls.at(-1)![0]);
      expect(plain.indexOf('Newest answer')).toBeLessThan(plain.indexOf('Older answer'));
      expect(plain).not.toContain('Planning notes');
      expect(plain).not.toContain('Undated answer');
      // Read-only inspection: no thread.jsonl, index, lock or memo was created.
      expect(existsSync(leaderThreadPath())).toBe(false);
      expect(existsSync(join(leaderRoot(), 'thread-index.json'))).toBe(false);
      expect(existsSync(join(leaderRoot(), '.thread.lock'))).toBe(false);
      expect(readdirSync(join(runsDir, 'leader')).sort()).toEqual(before);
    } finally { log.mockRestore(); }
  }, 30_000);

  it('reports a missing JSON source with its reason and exit 0', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runLeaderCli(['replies', '--json', '--file', absentFile])).toBe(0);
      const result = lastJson(log);
      expect(result.sourceState).toBe('missing');
      expect(result.entries).toEqual([]);
      expect(result.reason).toContain(`No PLAN-LOG file at ${absentFile}`);
    } finally { log.mockRestore(); }
  }, 30_000);

  it('keeps identical reply text on different dates but dedupes it within one date via the real reader', async () => {
    writePlan(fileFile, [
      reply('2026-11-08 09:00', 'Same answer'),
      reply('2026-11-08 10:00', 'Same answer'),
      reply('2026-11-09 09:00', 'Same answer'),
    ].join('\n'));
    const result = await readPlanLogReplies({ file: fileFile });
    expect(result.sourceState).toBe('healthy');
    expect(result.entries.map(e => [e.at, e.text])).toEqual([
      ['2026-11-08 10:00', 'Same answer'],
      ['2026-11-09 09:00', 'Same answer'],
    ]);
  }, 30_000);
});
