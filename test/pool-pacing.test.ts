import { describe, expect, it } from 'vitest';
import { usageVerdict } from '../src/core/queue/admission.js';

describe('weekly admission pacing', () => {
  const now = 1800000000_000;
  it.each([[0, 10, true], [0, 11, false], [.5, 60, true], [.5, 69, false], [.999999, 69, true]])('elapsed %s used %s', (elapsed, used, admit) => {
    expect(usageVerdict({ weekly_used_pct: used, reset_at: (now + (1 - Number(elapsed)) * 604800_000) / 1000 }, now).admit).toBe(admit);
  });
  it('reserves through 95% for critical work with unknown resets', () => {
    expect(usageVerdict({ weekly_used_pct: 95 }, now, true).admit).toBe(true);
    expect(usageVerdict({ weekly_used_pct: 96 }, now, true).admit).toBe(false);
    expect(usageVerdict({ weekly_used_pct: 69 }, now).admit).toBe(false);
    expect(usageVerdict({ weekly_used_pct: 60 }, now).admit).toBe(true);
  });
  it('accepts ISO resets and reports missing usage', () => {
    expect(usageVerdict({ weekly_used_pct: 69, reset_at: new Date(now + 1).toISOString() }, now).admit).toBe(true);
    expect(usageVerdict({}, now).reason).toBe('usage unknown');
  });
});
