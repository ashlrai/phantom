/**
 * The missing-model guard (src/core/local-runtime/missing-model-guard.ts) —
 * the decision that turns a deleted Ollama blob from a ten-second launchd
 * restart loop into one blocked state that reports itself and backs off.
 *
 * Pinned here is the whole contract the generated shim relies on:
 *
 *   - a present — or re-resolved — file is always `run`, so recovery needs
 *     no human step;
 *   - a new failure is `blocked`: the stamp is written BEFORE the attempt
 *     holds, and exactly one line names the model and the fix;
 *   - a failure inside the previous window is `retry-after`: no new stamp,
 *     no second line, only the remainder of the window is held;
 *   - a state file that is absent, corrupt or the wrong shape is "no prior
 *     failure", never a reason to spin or to crash the shim path.
 *
 * Everything is temp-directory bound or injected: no process is spawned, no
 * real home is touched, and no real backoff is waited — the clock, the stat
 * and the sleep are all parameters.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MISSING_MODEL_BACKOFF_MS,
  checkMissingModel,
  decideMissingModel,
  missingModelBlockedLine,
  missingModelStatePath,
  readMissingModelLastFailedAt,
  recordMissingModelFailure,
  waitMissingModelBackoff,
} from '../src/core/local-runtime/missing-model-guard.js';

const BACKOFF = MISSING_MODEL_BACKOFF_MS;
const NOW = 1_800_000_000_000; // a fixed epoch ms — no wall clock in these tests

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'missing-model-guard-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function stamp(dir: string, lastFailedAtMs: number): string {
  const statePath = join(dir, 'missing-model.json');
  writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 1, lastFailedAt: lastFailedAtMs })}\n`);
  return statePath;
}

// ---------------------------------------------------------------------------
// decideMissingModel — the pure table
// ---------------------------------------------------------------------------

describe('decideMissingModel', () => {
  it('runs when the file is present, whatever the stamp says', () => {
    expect(
      decideMissingModel({ modelExists: true, resolvable: false, lastFailedAtMs: null, nowMs: NOW }),
    ).toBe('run');
    expect(
      decideMissingModel({ modelExists: true, resolvable: false, lastFailedAtMs: NOW, nowMs: NOW }),
    ).toBe('run');
  });

  it('runs when the file is missing but could be re-resolved', () => {
    expect(
      decideMissingModel({ modelExists: false, resolvable: true, lastFailedAtMs: NOW, nowMs: NOW }),
    ).toBe('run');
  });

  it('blocks a first failure — no prior stamp', () => {
    expect(
      decideMissingModel({ modelExists: false, resolvable: false, lastFailedAtMs: null, nowMs: NOW }),
    ).toBe('blocked');
  });

  it('waits out an active backoff', () => {
    expect(
      decideMissingModel({
        modelExists: false, resolvable: false, lastFailedAtMs: NOW - 1_000, nowMs: NOW,
      }),
    ).toBe('retry-after');
  });

  it('blocks again once the backoff has expired', () => {
    expect(
      decideMissingModel({
        modelExists: false, resolvable: false, lastFailedAtMs: NOW - BACKOFF, nowMs: NOW,
      }),
    ).toBe('blocked');
    expect(
      decideMissingModel({
        modelExists: false, resolvable: false, lastFailedAtMs: NOW - BACKOFF - 1, nowMs: NOW,
      }),
    ).toBe('blocked');
  });

  it('treats a stamp in the future as still inside the window', () => {
    expect(
      decideMissingModel({
        modelExists: false, resolvable: false, lastFailedAtMs: NOW + BACKOFF * 4, nowMs: NOW,
      }),
    ).toBe('retry-after');
  });
});

// ---------------------------------------------------------------------------
// checkMissingModel — the thin file seam: stat + stamp + decide
// ---------------------------------------------------------------------------

describe('checkMissingModel', () => {
  it('runs when the model file is present, and writes no stamp', () => {
    const dir = tempDir();
    const modelPath = join(dir, 'model.gguf');
    writeFileSync(modelPath, 'gguf');
    const statePath = join(dir, 'missing-model.json');
    const check = checkMissingModel({ modelPath, resolvable: false, statePath, nowMs: NOW });
    expect(check).toEqual({ decision: 'run', waitMs: 0, line: null });
    expect(readMissingModelLastFailedAt(statePath)).toBeNull();
  });

  it('runs when the file is missing but resolvable, and writes no stamp', () => {
    const dir = tempDir();
    const statePath = join(dir, 'missing-model.json');
    const check = checkMissingModel({
      modelPath: join(dir, 'gone.gguf'),
      resolvable: true,
      statePath,
      nowMs: NOW,
    });
    expect(check.decision).toBe('run');
    expect(readMissingModelLastFailedAt(statePath)).toBeNull();
  });

  it('blocks a missing, unresolvable model: stamps first, one line, full window', () => {
    const dir = tempDir();
    const statePath = join(dir, 'missing-model.json');
    const check = checkMissingModel({
      modelPath: join(dir, 'gone.gguf'),
      resolvable: false,
      modelName: 'qwen3.8:27b-ctx64k',
      statePath,
      nowMs: NOW,
    });
    expect(check.decision).toBe('blocked');
    expect(check.waitMs).toBe(BACKOFF);
    // One line, and it names the model and the fix.
    expect(check.line).toContain('qwen3.8:27b-ctx64k');
    expect(check.line).toContain('ashlr local-runtime install');
    expect(check.line?.split('\n').length).toBe(1);
    // The stamp was written at decision time — a crash mid-hold still counts.
    expect(readMissingModelLastFailedAt(statePath)).toBe(NOW);
  });

  it('waits only the remainder while the backoff is still active', () => {
    const dir = tempDir();
    const tenMinutesAgo = NOW - 10 * 60 * 1000;
    const statePath = stamp(dir, tenMinutesAgo);
    const check = checkMissingModel({
      modelPath: join(dir, 'gone.gguf'),
      resolvable: false,
      statePath,
      nowMs: NOW,
    });
    expect(check.decision).toBe('retry-after');
    expect(check.waitMs).toBe(BACKOFF - 10 * 60 * 1000);
    expect(check.line).toBeNull();
    // No new stamp, no new line: the recorded attempt stays the original one.
    expect(readMissingModelLastFailedAt(statePath)).toBe(tenMinutesAgo);
  });

  it('blocks — and restamps — once the backoff has expired', () => {
    const dir = tempDir();
    const statePath = stamp(dir, NOW - BACKOFF - 60_000);
    const check = checkMissingModel({
      modelPath: join(dir, 'gone.gguf'),
      resolvable: false,
      statePath,
      nowMs: NOW,
    });
    expect(check.decision).toBe('blocked');
    expect(check.waitMs).toBe(BACKOFF);
    expect(check.line).not.toBeNull();
    expect(readMissingModelLastFailedAt(statePath)).toBe(NOW);
  });

  it('runs the moment the file is back, even inside a fresh backoff window', () => {
    const dir = tempDir();
    // The previous attempt blocked seconds ago — the window is wide open —
    // but the blob has been restored: nothing may gate on the stamp.
    const statePath = stamp(dir, NOW - 5 * 60 * 1000);
    const modelPath = join(dir, 'model.gguf');
    writeFileSync(modelPath, 'gguf');
    const check = checkMissingModel({ modelPath, resolvable: false, statePath, nowMs: NOW });
    expect(check.decision).toBe('run');
    expect(check.waitMs).toBe(0);
  });

  it('treats a corrupt state file as no prior failure, then restamps it valid', () => {
    const dir = tempDir();
    const statePath = join(dir, 'missing-model.json');
    writeFileSync(statePath, 'this is {not: json at all');
    const check = checkMissingModel({
      modelPath: join(dir, 'gone.gguf'),
      resolvable: false,
      statePath,
      nowMs: NOW,
    });
    expect(check.decision).toBe('blocked');
    // And what was rewritten is a readable stamp, so the next attempt sees it.
    expect(readMissingModelLastFailedAt(statePath)).toBe(NOW);
  });

  it('treats an oversized state file as no prior failure', () => {
    const dir = tempDir();
    const statePath = join(dir, 'missing-model.json');
    writeFileSync(statePath, 'x'.repeat(8 * 1024));
    expect(readMissingModelLastFailedAt(statePath)).toBeNull();
  });

  it('clamps the remaining wait to the window when the stamp is in the future', () => {
    const dir = tempDir();
    const statePath = stamp(dir, NOW + 6 * BACKOFF);
    const check = checkMissingModel({
      modelPath: join(dir, 'gone.gguf'),
      resolvable: false,
      statePath,
      nowMs: NOW,
    });
    expect(check.decision).toBe('retry-after');
    expect(check.waitMs).toBe(BACKOFF);
  });
});

// ---------------------------------------------------------------------------
// The stamp file itself
// ---------------------------------------------------------------------------

describe('the state file', () => {
  it('lives under ~/.ashlr/local-runtime so a relocated HOME follows it', () => {
    expect(missingModelStatePath()).toBe(
      join(homedir(), '.ashlr', 'local-runtime', 'missing-model.json'),
    );
  });

  it('round-trips an epoch ms and reads nothing from shapes it did not write', () => {
    const dir = tempDir();
    const statePath = join(dir, 'missing-model.json');
    recordMissingModelFailure(statePath, NOW);
    expect(readMissingModelLastFailedAt(statePath)).toBe(NOW);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      lastFailedAt: NOW,
    });
    for (const bad of ['[]', '"x"', '12', '{"lastFailedAt":"soon"}', '{"lastFailedAt":-5}']) {
      writeFileSync(statePath, bad);
      expect(readMissingModelLastFailedAt(statePath)).toBeNull();
    }
  });

  it('reads null from a path that does not exist', () => {
    expect(readMissingModelLastFailedAt(join(tempDir(), 'never-written.json'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// waitMissingModelBackoff — the hold that recovers the moment the file is back
// ---------------------------------------------------------------------------

describe('waitMissingModelBackoff', () => {
  const sleepRecording = (clock: { t: number }, sleeps: number[]) =>
    async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    };

  it('returns run the moment the file reappears mid-window', async () => {
    const clock = { t: 0 };
    const sleeps: number[] = [];
    const outcome = await waitMissingModelBackoff({
      modelPath: '/x/model.gguf',
      waitMs: BACKOFF,
      pollMs: 1_000,
      fileExists: () => clock.t >= 2_500,
      now: () => clock.t,
      sleep: sleepRecording(clock, sleeps),
    });
    expect(outcome).toBe('run');
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(clock.t).toBeLessThan(BACKOFF);
  });

  it('expires after waitMs when the file never comes back', async () => {
    const clock = { t: 0 };
    const outcome = await waitMissingModelBackoff({
      modelPath: '/x/model.gguf',
      waitMs: 2_500,
      pollMs: 1_000,
      fileExists: () => false,
      now: () => clock.t,
      sleep: sleepRecording(clock, []),
    });
    expect(outcome).toBe('expired');
    expect(clock.t).toBe(2_500);
  });

  it('expires immediately when nothing is left of the window', async () => {
    const clock = { t: 0 };
    const stat = { called: false };
    const outcome = await waitMissingModelBackoff({
      modelPath: '/x/model.gguf',
      waitMs: 0,
      fileExists: () => {
        stat.called = true;
        return true;
      },
      now: () => clock.t,
      sleep: sleepRecording(clock, []),
    });
    expect(outcome).toBe('expired');
    expect(stat.called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The line the operator sees
// ---------------------------------------------------------------------------

describe('missingModelBlockedLine', () => {
  it('names the model and the fix on one line', () => {
    const line = missingModelBlockedLine('qwen3.8:27b-ctx64k');
    expect(line).toContain('qwen3.8:27b-ctx64k');
    expect(line).toContain('ashlr local-runtime install');
    expect(line.split('\n').length).toBe(1);
  });
});
