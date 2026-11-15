import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADAPTIVE_START_LEVEL,
  currentThroughputLevel,
  nextThroughputLevel,
  noteResidentTickOutcome,
  noteThroughputSample,
  resetAdaptiveThroughput,
  resolveDaemonCountPreferences,
} from '../src/core/daemon/count-preferences.js';
import { VERSE_CAPS_DEFAULTS } from '../src/core/verse/control-api.js';

describe('adaptive throughput', () => {
  beforeEach(() => resetAdaptiveThroughput());

  it('starts at the ramp floor and steps up while nothing is measured', () => {
    expect(ADAPTIVE_START_LEVEL).toBe(VERSE_CAPS_DEFAULTS.perTickItems);
    expect(ADAPTIVE_START_LEVEL).toBe(VERSE_CAPS_DEFAULTS.parallel);
    expect(nextThroughputLevel(null, {})).toEqual({ level: 1, measuredLimit: null, rule: 'ramp' });
    expect(nextThroughputLevel({ level: 1, measuredLimit: null }, {})).toEqual({ level: 2, measuredLimit: null, rule: 'ramp' });
    expect(noteThroughputSample({}).level).toBe(2);
    expect(noteThroughputSample({}).level).toBe(3);
  });

  it('backs off to a measured limit and holds there', () => {
    noteThroughputSample({});
    noteThroughputSample({});
    expect(currentThroughputLevel().level).toBe(3);
    const backed = noteThroughputSample({ saturated: true });
    expect(backed).toMatchObject({ level: 2, measuredLimit: 3, rule: 'back-off' });
    expect(noteThroughputSample({})).toMatchObject({ level: 2, measuredLimit: 3, rule: 'hold' });
  });

  it('reads fresh headroom and ignores Devin and claude-api spend windows', () => {
    noteThroughputSample({});
    noteThroughputSample({});
    expect(noteThroughputSample({
      windows: [
        { lane: 'devin', status: 'fresh', headroom: 0 },
        { lane: 'claude-api', status: 'fresh', headroom: 0 },
      ],
    }).rule).toBe('ramp');
    expect(noteThroughputSample({
      windows: [{ lane: 'codex-personal', status: 'fresh', headroom: 0 }],
    })).toMatchObject({ rule: 'back-off' });
    const recovered = noteThroughputSample({
      windows: [{ lane: 'codex-personal', status: 'fresh', headroom: 4 }],
    });
    expect(recovered.rule).toBe('ramp');
    expect(recovered.measuredLimit).toBeNull();
    expect(recovered.level).toBeGreaterThan(1);
  });

  it('keeps an explicit count and an explicit null ceiling', () => {
    noteThroughputSample({});
    expect(resolveDaemonCountPreferences({})).toMatchObject({
      perTickItems: 2,
      parallel: 2,
      maxConcurrent: 2,
      concurrency: { local: 2, cloud: 2, total: 2 },
    });
    expect(resolveDaemonCountPreferences({
      perTickItems: 5,
      parallel: 4,
      maxConcurrent: null,
      concurrency: { local: 3, cloud: 9, total: 12 },
    })).toEqual({
      perTickItems: 5,
      parallel: 4,
      maxConcurrent: null,
      concurrency: { local: 3, cloud: 9, total: 12 },
    });
  });

  it('treats a failed or timed-out resident tick as saturation', () => {
    expect(noteResidentTickOutcome('ok').rule).toBe('ramp');
    expect(noteResidentTickOutcome('timeout')).toMatchObject({ rule: 'back-off', level: 1, measuredLimit: 2 });
    expect(noteResidentTickOutcome(null)).toMatchObject({ rule: 'hold', level: 1, measuredLimit: 2 });
    expect(noteResidentTickOutcome('failed')).toMatchObject({ rule: 'back-off', level: 1 });
  });
});
