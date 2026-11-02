import { describe, expect, it } from 'vitest';
import { planChangeDigest, type DigestEvent, type DigestFacts, type DigestState } from '../src/core/comms/change-digest.js';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const HOUR = 3_600_000;
const facts = (events: DigestEvent[] = []): DigestFacts => ({
  events,
  seats: null,
  autonomy: { on: true, mode: 'autonomous' },
});
const event = (key: string, at: string): DigestEvent => ({ key, at, kind: 'merge', text: key, work: true });
const state = (lastActivityAt: string, idleNoticeFor: string | null = null): DigestState => ({
  v: 1,
  lastCheckAt: '2026-09-26T10:00:00.000Z',
  lastSentAt: null,
  lastActivityAt,
  reported: [],
  exhaustedSeats: [],
  idleNoticeFor,
});

describe('change digest event time ordering', () => {
  it('orders mixed offsets by instant and advances to the newest work, not the lexically greatest time', () => {
    const previous = state('2026-09-26T11:00:00+02:00'); // 09:00Z
    const plan = planChangeDigest(previous, facts([
      event('older', '2026-09-26T12:00:00+02:00'), // 10:00Z
      event('newer', '2026-09-26T07:00:00-04:00'), // 11:00Z
    ]), NOW);

    expect(plan.reason).toBe('changes');
    expect(plan.text).toContain('Merged (2):\n• older\n• newer');
    expect(plan.next.reported).toEqual(['older', 'newer']);
    expect(plan.next.lastActivityAt).toBe('2026-09-26T07:00:00-04:00');
    expect(planChangeDigest(plan.next, facts([
      event('older', '2026-09-26T12:00:00+02:00'),
      event('newer', '2026-09-26T07:00:00-04:00'),
    ]), NOW + HOUR).reason).toBe('unchanged');
  });

  it('orders equal instants by key regardless of input order and keeps an equal baseline unchanged', () => {
    const baseline = '2026-09-26T11:00:00Z';
    const events = [event('z', '2026-09-26T13:00:00+02:00'), event('a', '2026-09-26T07:00:00-04:00')];
    const forward = planChangeDigest(state(baseline, baseline), facts(events), NOW);
    const reverse = planChangeDigest(state(baseline, baseline), facts([...events].reverse()), NOW);

    expect(forward.text).toBe(reverse.text);
    expect(forward.text).toContain('Merged (2):\n• a\n• z');
    expect(forward.next.reported).toEqual(['a', 'z']);
    expect(forward.next.lastActivityAt).toBe(baseline);
    expect(forward.next.idleNoticeFor).toBe(baseline);
  });

  it('ignores malformed timestamps without consuming their keys, so corrected events can be reported', () => {
    const previous = state('2026-09-26T10:00:00Z');
    const bad = planChangeDigest(previous, facts([event('correctable', 'not-a-time')]), NOW);
    expect(bad.reason).toBe('unchanged');
    expect(bad.next.lastActivityAt).toBe(previous.lastActivityAt);
    expect(bad.next.reported).toEqual([]);

    const corrected = planChangeDigest(bad.next, facts([event('correctable', '2026-09-26T11:00:00Z')]), NOW);
    expect(corrected.reason).toBe('changes');
    expect(corrected.next.reported).toEqual(['correctable']);
    expect(corrected.next.lastActivityAt).toBe('2026-09-26T11:00:00Z');
  });

  it('reports older late and future events without resetting idle, then handles real activity and the next idle stretch', () => {
    const baseline = '2026-09-25T10:00:00Z';
    const previous = state(baseline, baseline);
    const lateAndFuture = facts([
      event('late', '2026-09-25T12:30:00+03:00'), // 09:30Z, older than baseline
      event('future', '2026-10-26T12:00:00Z'),
    ]);
    const reported = planChangeDigest(previous, lateAndFuture, NOW);
    expect(reported.reason).toBe('changes');
    expect(reported.next.reported).toEqual(['late', 'future']);
    expect(reported.next.lastActivityAt).toBe(baseline);
    expect(reported.next.idleNoticeFor).toBe(baseline);
    expect(planChangeDigest(reported.next, lateAndFuture, NOW + HOUR).reason).toBe('unchanged');

    const realAt = new Date(NOW + 2 * HOUR).toISOString();
    const busy = planChangeDigest(reported.next, facts([event('real', realAt)]), NOW + 2 * HOUR);
    expect(busy.reason).toBe('changes');
    expect(busy.next.lastActivityAt).toBe(realAt);
    expect(busy.next.idleNoticeFor).toBeNull();
    expect(planChangeDigest(busy.next, facts(), NOW + 25 * HOUR).reason).toBe('unchanged');
    const idle = planChangeDigest(busy.next, facts(), NOW + 26 * HOUR);
    expect(idle.reason).toBe('idle');
    expect(idle.next.idleNoticeFor).toBe(realAt);
    expect(planChangeDigest(idle.next, facts(), NOW + 27 * HOUR).reason).toBe('unchanged');
  });

  it('reports future work once and still detects an unannounced idle stretch on the next check', () => {
    const baseline = '2026-09-25T10:00:00Z';
    const future = facts([event('future', '2026-09-27T12:00:00Z')]);
    const reported = planChangeDigest(state(baseline), future, NOW);
    expect(reported.reason).toBe('changes');
    expect(reported.next.lastActivityAt).toBe(baseline);
    expect(reported.next.reported).toEqual(['future']);
    const idle = planChangeDigest(reported.next, future, NOW + HOUR);
    expect(idle.reason).toBe('idle');
    expect(idle.next.idleNoticeFor).toBe(baseline);
    expect(planChangeDigest(idle.next, future, NOW + 25 * HOUR).reason).toBe('unchanged');
  });

  it.each(['invalid', '2027-01-01T00:00:00Z'])(
    'recovers a previously poisoned watermark (%s) and eventually detects idle',
    (badTime) => {
      const recovered = planChangeDigest(state(badTime), facts(), NOW);
      expect(recovered.reason).toBe('unchanged');
      expect(recovered.next.lastActivityAt).toBe(new Date(NOW).toISOString());
      expect(planChangeDigest(recovered.next, facts(), NOW + 24 * HOUR).reason).toBe('idle');
    },
  );
});
