import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HARNESS_STALE_DAYS,
  isHarnessDateStale,
  parseUtcCalendarDate,
  utcDayStartMs,
} from '../src/core/learn/harness-digest-reader.js';
import { ensureNightlyInputs } from '../src/core/learn/retro/feed.js';
import {
  inspectNightlyDirectory,
  isRecord,
  learnHome,
  readKnowledge,
  RETRO_ID_PATTERN,
  RETRO_REPO_PATTERN,
  updateKnowledge,
} from '../src/core/learn/retro/store.js';
import { formatHarnessDisplayField } from '../src/cli/reflect-harness-digest.js';

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'phantom-learn-shared-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('learn retro shared store guards and patterns', () => {
  it('isRecord accepts non-null non-array objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('text')).toBe(false);
    expect(isRecord(42)).toBe(false);
  });

  it('validates canonical owner/repo and retro identifiers', () => {
    expect(RETRO_REPO_PATTERN.test('ashlrai/phantom')).toBe(true);
    expect(RETRO_REPO_PATTERN.test('owner/repo.name_1-2')).toBe(true);
    expect(RETRO_REPO_PATTERN.test('not-a-repo')).toBe(false);
    expect(RETRO_REPO_PATTERN.test('a/b/c')).toBe(false);
    expect(RETRO_REPO_PATTERN.test('ashlrai/phantom\n')).toBe(false);

    expect(RETRO_ID_PATTERN.test('RQ-TEST-1')).toBe(true);
    expect(RETRO_ID_PATTERN.test('cloud:ct_123/a.b')).toBe(true);
    expect(RETRO_ID_PATTERN.test('')).toBe(false);
    expect(RETRO_ID_PATTERN.test('-leading-dash')).toBe(false);
    expect(RETRO_ID_PATTERN.test('has space')).toBe(false);
  });

  it('inspectNightlyDirectory creates private directories and refuses symlinks', async () => {
    await inspectNightlyDirectory(true, true);
    const inputDir = join(learnHome(), 'retro-input');
    const info = await stat(inputDir);
    expect(info.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(info.mode & 0o022).toBe(0);
    }

    await rm(inputDir, { recursive: true, force: true });
    const redirect = join(home, 'redirect-input');
    await mkdir(redirect, { mode: 0o700 });
    await symlink(redirect, inputDir, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectNightlyDirectory(true, false)).rejects.toThrow('Unsafe nightly directory');
    await expect(inspectNightlyDirectory(true, true)).rejects.toThrow('Unsafe nightly directory');
  });

  it('persists knowledge updates atomically without leaving tmp files behind', async () => {
    const saved = await updateKnowledge((notes) => ({
      notes: [
        ...notes,
        {
          v: 1,
          id: 'kn_0123456789abcdef',
          text: 'Always run targeted verification before committing.',
          scope: { repo: 'ashlrai/phantom', pathGlobs: ['src/core/learn/**'], taskKinds: ['fix'] },
          status: 'approved',
          retroId: null,
          source: 'mason',
          createdAt: '2026-11-01T00:00:00.000Z',
          decidedAt: '2026-11-01T00:00:00.000Z',
          edited: false,
          hits: 0,
          lastHitAt: null,
          seen: 1,
          agentsMdTaskId: null,
        },
      ],
      result: true,
    }));
    expect(saved).toBe(true);
    const loaded = await readKnowledge();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('kn_0123456789abcdef');
  });
});

describe('learn retro feed shared merge and conflict handling', () => {
  it('merges fleet jobs and leaves conflicting existing jobs.jsonl untouched', async () => {
    const runsDir = join(home, 'runs');
    const metricsDir = join(runsDir, 'metrics');
    await mkdir(metricsDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(metricsDir, 'jobs.jsonl'),
      `${JSON.stringify({
        event: 'outcome',
        job: 'RQ-SHARED-1',
        repo: 'ashlrai/phantom',
        lane: 'work',
        state: 'MERGED',
        ts: '2026-10-25T23:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    const nowMs = Date.parse('2026-10-26T02:00:00.000Z');
    await ensureNightlyInputs({ runsDir, nowMs, cloudTasks: () => [], devinTasks: () => [] });

    const jobsPath = join(learnHome(), 'retro-input', 'jobs.jsonl');
    const initial = await readFile(jobsPath, 'utf8');
    expect(JSON.parse(initial.trim())).toMatchObject({
      v: 1,
      id: 'RQ-SHARED-1',
      repo: 'ashlrai/phantom',
      arm: 'work',
      status: 'succeeded',
    });

    // Conflicting rows at the same (repo, id, updatedAt) must fail closed without clobbering.
    const conflicting = [
      JSON.stringify({ v: 1, id: 'RQ-CONF-1', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T20:00:00.000Z' }),
      JSON.stringify({ v: 1, id: 'RQ-CONF-1', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'failed', updatedAt: '2026-10-25T20:00:00.000Z' }),
    ].join('\n') + '\n';
    await writeFile(jobsPath, conflicting, { mode: 0o600 });

    await ensureNightlyInputs({ runsDir, nowMs, cloudTasks: () => [], devinTasks: () => [] });
    expect(await readFile(jobsPath, 'utf8')).toBe(conflicting);
  });
});

describe('harness digest shared calendar date, staleness, and CLI display helpers', () => {
  it('parses strict UTC calendar dates and rejects rollover dates', () => {
    expect(parseUtcCalendarDate('2026-11-01')).toBe(Date.UTC(2026, 10, 1));
    expect(parseUtcCalendarDate('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
    expect(parseUtcCalendarDate('2026-02-30')).toBeNull();
    expect(parseUtcCalendarDate('2026-13-01')).toBeNull();
    expect(parseUtcCalendarDate('2026-11-01T00:00:00Z')).toBeNull();
    expect(parseUtcCalendarDate('not-a-date')).toBeNull();
  });

  it('computes UTC day boundaries and staleness consistently', () => {
    const now = new Date('2026-11-10T23:59:59.999Z');
    expect(utcDayStartMs(now)).toBe(Date.UTC(2026, 10, 10));
    expect(DEFAULT_HARNESS_STALE_DAYS).toBe(7);
    // Exact boundary (7 days old) stays fresh; 8 days old is stale.
    expect(isHarnessDateStale('2026-11-03', now)).toBe(false);
    expect(isHarnessDateStale('2026-11-02', now)).toBe(true);
    expect(isHarnessDateStale('2026-11-09', now, 0)).toBe(true);
    expect(isHarnessDateStale('2026-11-10', now, 0)).toBe(false);
    expect(isHarnessDateStale(null, now)).toBe(false);
    expect(isHarnessDateStale('2026-02-30', now)).toBe(false);
  });

  it('formatHarnessDisplayField strips control/bidi bytes and collapses newlines', () => {
    expect(formatHarnessDisplayField('line1\r\n\nline2\u001b\u0007\u202eok')).toBe('line1 line2ok');
  });
});
