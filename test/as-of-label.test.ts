import { describe, expect, it } from 'vitest';
import { formatAsOf } from '../src/core/comms/as-of-label.js';

describe('formatAsOf', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  it('formats a fresh observation in UTC without seconds', () => {
    expect(formatAsOf('fleet', '2026-11-17T06:59:42-05:00', now))
      .toBe('as of 2026-11-17T11:59Z from fleet');
  });

  it('marks observations older than the default threshold as background', () => {
    expect(formatAsOf('fleet', '2026-11-17T11:44:59Z', now))
      .toBe('as of 2026-11-17T11:44Z from fleet (stale, background only)');
    expect(formatAsOf('fleet', '2026-11-17T11:45:00Z', now))
      .toBe('as of 2026-11-17T11:45Z from fleet');
  });

  it('labels invalid dates as unknown', () => {
    expect(formatAsOf('fleet', 'invalid', now)).toBe('as of unknown from fleet');
  });

  it('uses an unknown source for empty input', () => {
    expect(formatAsOf('  ', '2026-11-17T12:00:00Z', now))
      .toBe('as of 2026-11-17T12:00Z from unknown source');
  });

  it('honors a custom stale threshold', () => {
    expect(formatAsOf('fleet', '2026-11-17T11:59:00Z', now, 30_000))
      .toBe('as of 2026-11-17T11:59Z from fleet (stale, background only)');
  });
});
