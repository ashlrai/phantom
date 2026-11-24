import { describe, expect, it } from 'vitest';

import {
  createRecordedTelemetry,
  RECORDED_SCHEDULER_EVENT_NAMES,
  type RecordedSchedulerEvent,
} from '../src/core/providers/coding-cli/recorded-telemetry-recorder.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) createTelemetry() and SCHEDULER_EVENTS.
// All identifiers, timestamps and numbers are fake.

const fakeEvent = (index: number, overrides: Partial<RecordedSchedulerEvent> = {}): RecordedSchedulerEvent => ({
  event: 'phantom_pool_burndown',
  timestamp: `2026-01-01T00:00:0${index}.000Z`,
  distinctId: 'fake-distinct-id',
  properties: { pool_id: 'fake-pool', remaining_fraction: 0.5 - index / 10, estimate: true, reset_at: null },
  ...overrides,
});

const throwingSink = (): void => {
  throw new Error('sink must not be called');
};

describe('recorded scheduler telemetry recorder (PR #5952 recovery)', () => {
  it('keeps the three original scheduler event names', () => {
    expect([...RECORDED_SCHEDULER_EVENT_NAMES]).toEqual([
      'phantom_pool_burndown',
      'phantom_grok_ultra_runway',
      'phantom_pool_value_per_dollar',
    ]);
  });

  it('is disabled by default and when enabled is not exactly true: no retention, no sink call', () => {
    const byDefault = createRecordedTelemetry({ sink: throwingSink });
    byDefault.emit(fakeEvent(1));
    expect(byDefault.enabled).toBe(false);
    expect(byDefault.events).toEqual([]);

    const explicitlyOff = createRecordedTelemetry({ enabled: false, sink: throwingSink });
    explicitlyOff.emit(fakeEvent(2));
    expect(explicitlyOff.events).toEqual([]);

    // Only the boolean true opts in; an untyped string 'true' does not.
    const stringTrue = createRecordedTelemetry({ enabled: 'true' as unknown as boolean, sink: throwingSink });
    expect(stringTrue.enabled).toBe(false);
    stringTrue.emit(fakeEvent(3));
    expect(stringTrue.events).toEqual([]);
    expect(createRecordedTelemetry().events).toEqual([]);
  });

  it('when enabled, retains events in emission order and calls the sink once per emission', () => {
    const seen: RecordedSchedulerEvent[] = [];
    const recorder = createRecordedTelemetry({ enabled: true, sink: (event) => seen.push(event) });
    const events = [
      fakeEvent(1, { event: 'phantom_pool_burndown' }),
      fakeEvent(2, { event: 'phantom_grok_ultra_runway' }),
      fakeEvent(3, { event: 'phantom_pool_value_per_dollar' }),
    ];
    for (const event of events) recorder.emit(event);

    expect(recorder.enabled).toBe(true);
    expect(recorder.events).toEqual(events);
    expect(seen).toHaveLength(3);
    seen.forEach((event, i) => expect(event).toBe(recorder.events[i]));
  });

  it('works enabled without a sink', () => {
    const recorder = createRecordedTelemetry({ enabled: true });
    recorder.emit(fakeEvent(1));
    recorder.emit(fakeEvent(2));
    expect(recorder.events.map((event) => event.timestamp)).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
    ]);
  });

  it('keeps caller-supplied timestamp, distinctId and properties unchanged, by reference', () => {
    const recorder = createRecordedTelemetry({ enabled: true });
    const properties = { pool_id: 'fake-pool-b', value_per_dollar: null, jobs: 3, ok: false, ratio: 0.25 };
    const event = fakeEvent(4, {
      event: 'phantom_pool_value_per_dollar',
      timestamp: '2026-11-19T12:34:56.789Z',
      distinctId: 'fake-router',
      properties,
    });
    recorder.emit(event);
    expect(recorder.events[0]).toBe(event);
    expect(recorder.events[0]?.timestamp).toBe('2026-11-19T12:34:56.789Z');
    expect(recorder.events[0]?.distinctId).toBe('fake-router');
    expect(recorder.events[0]?.properties).toEqual(properties);
  });

  it('retains the event before the sink runs, so a throwing sink still leaves it recorded', () => {
    const recorder = createRecordedTelemetry({
      enabled: true,
      sink: () => {
        throw new Error('fake sink failure');
      },
    });
    const event = fakeEvent(5);
    expect(() => recorder.emit(event)).toThrow('fake sink failure');
    expect(recorder.events).toEqual([event]);
  });
});
