/**
 * saveRun under concurrent saves of OTHER runs.
 *
 * Every save renames a record into ~/.ashlr/runs/, moving the directory
 * snapshot that saveRun's stable read of its own current record binds to. That
 * read then reports `changed-during-read` although this run's record is held
 * under its own write lock. saveRun re-reads a bounded number of times on
 * exactly that reason and still fails closed when the instability persists or
 * the read fails for any other reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type StableRead = typeof import('../src/core/util/stable-file-read.js');
type StableReadFailure = 'changed-during-read' | 'unsafe-file';

const injection = vi.hoisted(() => ({
  target: null as string | null,
  remaining: 0,
  reason: 'changed-during-read' as StableReadFailure,
  calls: 0,
  beforeFailure: null as (() => void) | null,
}));

vi.mock('../src/core/util/stable-file-read.js', async (importOriginal) => {
  const actual = await importOriginal<StableRead>();
  return {
    ...actual,
    readStableRegularFile: (filePath: string, options: Parameters<StableRead['readStableRegularFile']>[1]) => {
      if (filePath !== injection.target) return actual.readStableRegularFile(filePath, options);
      injection.calls += 1;
      if (injection.remaining > 0) {
        injection.remaining -= 1;
        injection.beforeFailure?.();
        return { ok: false as const, reason: injection.reason };
      }
      return actual.readStableRegularFile(filePath, options);
    },
  };
});

import { loadRun, saveRun } from '../src/core/run/orchestrator.js';
import type { RunState } from '../src/core/types.js';

let home: string;
let priorHome: string | undefined;
let priorProfile: string | undefined;

function makeRun(id: string): RunState {
  const now = '2026-10-15T00:00:00.000Z';
  return {
    id,
    goal: 'stable read churn',
    engine: 'builtin',
    provider: 'none',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'running',
  } as RunState;
}

function runFile(id: string): string {
  return join(home, '.ashlr', 'runs', `${id}.json`);
}

/** What a concurrent saver of a different run does to the shared runs/ directory. */
function siblingRunSave(tag: string): void {
  const runs = join(home, '.ashlr', 'runs');
  const tmp = join(runs, `.run-sibling.json.${tag}.tmp`);
  writeFileSync(tmp, '{}\n', { mode: 0o600 });
  renameSync(tmp, join(runs, 'run-sibling.json'));
}

beforeEach(() => {
  priorHome = process.env['HOME'];
  priorProfile = process.env['USERPROFILE'];
  home = mkdtempSync(join(tmpdir(), 'ashlr-run-save-churn-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  injection.target = null;
  injection.remaining = 0;
  injection.reason = 'changed-during-read';
  injection.calls = 0;
  injection.beforeFailure = null;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('saveRun current-record read under runs/ directory churn', () => {
  it('re-reads its own record when a sibling save moved the directory during the read', () => {
    const run = makeRun('run-churn-transient');
    saveRun(run);
    injection.target = runFile(run.id);
    injection.remaining = 2;
    injection.beforeFailure = () => siblingRunSave(String(injection.calls));

    run.status = 'done';
    expect(() => saveRun(run)).not.toThrow();
    expect(injection.calls).toBe(3);
    expect(loadRun(run.id)?.status).toBe('done');
  });

  it('fails closed after a bounded number of reads when the directory never stabilizes', () => {
    const run = makeRun('run-churn-persistent');
    saveRun(run);
    const before = readFileSync(runFile(run.id), 'utf8');
    injection.target = runFile(run.id);
    injection.remaining = Number.POSITIVE_INFINITY;
    injection.beforeFailure = () => siblingRunSave(String(injection.calls));

    run.status = 'done';
    expect(() => saveRun(run)).toThrow(/Run persistence source is unsafe: changed-during-read/);
    expect(injection.calls).toBeGreaterThan(1);
    expect(injection.calls).toBeLessThanOrEqual(5);
    expect(readFileSync(runFile(run.id), 'utf8')).toBe(before);
  });

  it('does not retry any other stable-read failure', () => {
    const run = makeRun('run-churn-unsafe');
    saveRun(run);
    const before = readFileSync(runFile(run.id), 'utf8');
    injection.target = runFile(run.id);
    injection.remaining = 1;
    injection.reason = 'unsafe-file';

    run.status = 'done';
    expect(() => saveRun(run)).toThrow(/Run persistence source is unsafe: unsafe-file/);
    expect(injection.calls).toBe(1);
    expect(readFileSync(runFile(run.id), 'utf8')).toBe(before);
  });
});
