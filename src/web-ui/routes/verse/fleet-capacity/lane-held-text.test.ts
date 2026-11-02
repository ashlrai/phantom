import { describe, expect, it } from 'vitest';
import { laneHeldText } from './lane-held-text.js';

const lane = { lane: 'codex-personal', held: true, heldReason: 'usage_limit' };
const personal = { resetsAt: '2026-11-04T06:41:00Z' };

describe('laneHeldText', () => {
  it('omits text for an unheld lane', () => {
    expect(laneHeldText({ ...lane, held: false }, personal)).toBeNull();
  });
  it('shows the held reason or just held when no reason is available', () => {
    expect(laneHeldText(lane, null)).toBe('held: usage_limit');
    expect(laneHeldText({ ...lane, heldReason: null }, null)).toBe('held');
    expect(laneHeldText({ ...lane, heldReason: '   ' }, null)).toBe('held');
  });
  it('formats the personal reset in Eastern time, including daylight saving time', () => {
    expect(laneHeldText(lane, personal)).toBe('held: usage_limit · resumes Nov 4 01:41 ET');
    expect(laneHeldText(lane, { resetsAt: '2026-10-31T05:41:00Z' })).toContain('Oct 31 01:41 ET');
    expect(laneHeldText(lane, { resetsAt: 'invalid' })).toBe('held: usage_limit');
  });
  it('does not apply the personal reset to other lanes', () => {
    expect(laneHeldText({ ...lane, lane: 'devin' }, personal)).toBe('held: usage_limit');
  });
  it('scrubs long tokens before limiting the reason length', () => {
    const token = 'x'.repeat(32);
    expect(laneHeldText({ ...lane, heldReason: `reason ${token} end` }, null)).toBe('held: reason [redacted] end');
    expect(laneHeldText({ ...lane, heldReason: Array(20).fill('word').join(' ') }, null)?.slice(6).length).toBeLessThanOrEqual(60);
    expect(laneHeldText({ ...lane, heldReason: 'x'.repeat(31) }, null)).toBe(`held: ${'x'.repeat(31)}`);
  });
});
