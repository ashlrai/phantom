import { describe, expect, it } from 'vitest';
import { claudeApiHealth } from '../src/core/drive/lane-health.js';
import { RECOVERY_PROBE_MS } from '../src/core/drive/lane-health.js';

const now = 10_000_000;
const finish = (id: string, at: number, exitCode = 13, emptyFinish = false, pool = 'claude-api') =>
  ({ id, pool, state: 'FAILED' as const, priority: 1, completedAtMs: at, exitCode, emptyFinish });
const ready = (id: string, pool = 'claude-api') => ({ id, pool, state: 'READY' as const, priority: 1 });

const failures = () => [finish('f1', now - 2000), finish('f2', now - 1000)];

describe('drive claude-api health — quiet-hour persistence', () => {
  it('a long gap with no finishes does not clear the reason', () => {
    // Lane is down at now-1000.  No new finishes arrive until now+2*HOUR.
    const jobs = [
      ...failures(),
      ready('api'),
    ];
    const during = now + 2 * 3_600_000;
    expect(claudeApiHealth(jobs, during).reason).toBe('repeated-code-13');
  });

  it('a finished job from another pool does not change the result', () => {
    // A successful devin finish arrives — it must be ignored by
    // the claude-api health check, leaving the lane parked.
    const jobs = [
      ...failures(),
      finish('devin-ok', now - 500, 0, false, 'devin'),
    ];
    expect(claudeApiHealth(jobs, now).reason).toBe('repeated-code-13');
  });
});
