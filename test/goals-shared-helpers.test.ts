import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GOAL_RUN_BUDGET,
  formatGoalError,
  goalIdIdentity,
  goalIdsMatch,
  isGoalRecordObject,
  isSha256Hex,
  isValidGoalId,
  isValidIsoTimestamp,
  parseIsoTimeMs,
  slugifyGoalText,
} from '../src/core/goals/open-goals.js';
import { canonicalGoalCorrelationRepo } from '../src/core/goals/project-match.js';
import { createGoal, createGoalIfAbsent, goalLockPath, goalsDir } from '../src/core/goals/store.js';

const origHome = process.env.HOME;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('goals shared pure helpers', () => {
  it('validates plain records, goal ids, sha256 hex digests, and ISO timestamps', () => {
    expect(isGoalRecordObject({})).toBe(true);
    expect(isGoalRecordObject(null)).toBe(false);
    expect(isGoalRecordObject([])).toBe(false);
    expect(isGoalRecordObject('x')).toBe(false);

    expect(isValidGoalId('goal-1.a_b')).toBe(true);
    expect(isValidGoalId('../escape')).toBe(false);
    expect(isValidGoalId('')).toBe(false);
    expect(isValidGoalId(123)).toBe(false);

    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);

    expect(parseIsoTimeMs('2026-01-02T03:04:05.000Z')).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    expect(parseIsoTimeMs('not-a-timestamp')).toBeNull();
    expect(parseIsoTimeMs('')).toBeNull();
    expect(parseIsoTimeMs(undefined)).toBeNull();
    expect(isValidIsoTimestamp('2026-01-02T03:04:05.000Z')).toBe(true);
    expect(isValidIsoTimestamp('bad')).toBe(false);
  });

  it('slugifies goal/milestone text, formats errors, and preserves default run budget', () => {
    expect(slugifyGoalText('  Ship Clean -- Goals!!  ')).toBe('ship-clean-goals');
    expect(slugifyGoalText('a-'.repeat(30), 32)).toBe('a-'.repeat(15) + 'a');
    expect(slugifyGoalText('!!!')).toBe('');
    expect(formatGoalError(new Error('boom'))).toBe('boom');
    expect(formatGoalError('plain')).toBe('plain');
    expect(goalIdsMatch('Goal-1', goalIdIdentity('Goal-1'))).toBe(true);
    expect(DEFAULT_GOAL_RUN_BUDGET).toEqual({ maxTokens: 200_000, maxSteps: 40, allowCloud: false });
  });
});

describe('goals shared path and store helpers', () => {
  it('resolves symlinked correlation repos and falls back for missing paths', () => {
    const root = makeTempDir('ashlr-goal-corr-');
    const target = join(root, 'real-repo');
    const link = join(root, 'link-repo');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    expect(canonicalGoalCorrelationRepo(link)).toBe(realpathSync.native(target));
    const missing = join(root, 'does-not-exist');
    expect(canonicalGoalCorrelationRepo(missing)).toBe(missing);
  });

  it('derives deterministic lock paths and keeps createGoal / createGoalIfAbsent aligned', () => {
    const home = makeTempDir('ashlr-goal-store-');
    process.env.HOME = home;
    const lock = goalLockPath('goal-abc');
    const expectedHash = createHash('sha256').update('goal-abc').digest('hex');
    expect(lock).toBe(join(goalsDir(), `.${expectedHash}.lock`));

    const now = '2026-05-01T12:00:00.000Z';
    const created = createGoalIfAbsent('Consolidate goals helpers', {
      now,
      cfg: { user: { id: 'u-1', name: 'Alice' } },
    });
    expect(created.status).toBe('created');
    const existing = createGoal('Consolidate goals helpers', {
      now,
      cfg: { user: { id: 'u-1', name: 'Alice' } },
    });
    expect(existing).toEqual(created.goal);
    expect(existing.owner).toBe('u-1');
  });
});
