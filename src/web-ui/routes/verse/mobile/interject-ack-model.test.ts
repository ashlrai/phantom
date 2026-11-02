import { describe, expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { LEADER_PASS_CADENCE_MS } from '../shell/fleet-needs-you.js';
import { mobileAckLine, mobileTime } from './interject-ack-model.js';

const minute = 60_000;
const now = Date.parse('2026-10-31T11:31:00Z');
const posted = now - minute;
const clock = (ms: number) => mobileTime(new Date(ms).toISOString());
const snapshot = (pass: number) => fleetRunsFixture({
  generatedAt: new Date(now).toISOString(), leaders: [{ label: 'fake leader', ageSeconds: (now - pass) / 1000 }],
});

describe('mobile interjection acknowledgement', () => {
  it('shows nothing before a post', () => {
    expect(mobileAckLine(null, snapshot(now - 6 * minute), now)).toBeNull();
  });

  it('shows the landed time and the shared pass countdown', () => {
    expect(mobileAckLine(posted, snapshot(now - 6 * minute), now)).toEqual({
      text: `Landed in the inbox ${clock(posted)} · next leader pass due in about 9 min`, tone: 'neutral',
    });
    expect(mobileAckLine(posted, undefined, now)?.text).toContain('next leader pass time unknown');
    expect(mobileAckLine(posted, snapshot(posted), now)?.tone).toBe('neutral');
  });

  it('warns when the pass is more than one cadence overdue', () => {
    const pass = now - 2 * LEADER_PASS_CADENCE_MS - minute;
    expect(mobileAckLine(posted, snapshot(pass), now)).toEqual({
      text: `Landed in the inbox ${clock(posted)} · No leader pass for 31 min`, tone: 'warning',
    });
    expect(mobileAckLine(posted, snapshot(now - 2 * LEADER_PASS_CADENCE_MS), now)?.tone).toBe('neutral');
  });

  it('shows the time of a newer leader pass', () => {
    const pass = posted + 30_000;
    expect(mobileAckLine(posted, snapshot(pass), now)).toEqual({ text: `Read by the ${clock(pass)} pass`, tone: 'ok' });
  });
});
