import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueAge, queueAge, type QueueAgeEvent } from '../src/cli/fleet-queue-age.js';
import { validQueueAgeEvents } from '../src/core/fleet/queue-age.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const fixture = 'test/fixtures/queue-age/events.json';
afterEach(() => vi.restoreAllMocks());
it('measures unordered fixture events, deduplicates and ranks the longest delays', async () => {
  const events = JSON.parse(await readFile(fixture, 'utf8')) as QueueAgeEvent[];
  const report = queueAge(events);
  expect(report.oldest_delays.map(d => d.seconds)).toEqual([120, 90, 30, 10]);
  expect(report.entries[1]!.delays.map(d => d.reason)).toEqual([null, 'missing', 'missing']);
  expect(queueAge([...events].reverse())).toEqual(report);
});
it('does not invent durations for repeated or reversed boundaries', () => {
  const events: QueueAgeEvent[] = [
    { pr: 'a/b#1', event: 'created', ts: '2026-01-01T00:00:10Z' },
    { pr: 'a/b#1', event: 'queue_entered', ts: '2026-01-01T00:00:00Z' },
    { pr: 'a/b#1', event: 'merged', ts: '2026-01-01T00:00:20Z' },
    { pr: 'a/b#1', event: 'merged', ts: '2026-01-01T00:00:30Z' },
  ];
  expect(queueAge(events).entries[0]!.delays.map(d => d.reason)).toEqual(['reversed', 'ambiguous', 'ambiguous']);
  expect(queueAge(events).oldest_delays).toEqual([]);
  expect(validQueueAgeEvents([{ ...events[0], ts: 'invalid' }])).toBe(false);
  expect(validQueueAgeEvents([{ ...events[0], event: 'unknown' }])).toBe(false);
  expect(validQueueAgeEvents({})).toBe(false);
});
it('offers read-only JSON and plain output through the fleet registry', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetQueueAge(['--events', fixture, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string).schema).toBe('fleet.queue-age.v1');
  expect(await cmdFleetQueueAge(['--events', fixture])).toBe(0);
  expect(log).toHaveBeenCalledWith('ashlrai/phantom#1: creation to merge took 120s');
  expect(await cmdFleetQueueAge(['--help'])).toBe(0);
  expect(await cmdFleetQueueAge([])).toBe(2);
  expect(await cmdFleetQueueAge(['--events', fixture, '--json', '--json'])).toBe(2);
  expect(await cmdFleetQueueAge(['--events', '/missing'])).toBe(1);
  expect(await cmdFleetQueueAge(['--events', 'package.json'])).toBe(1);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['queue-age']!()).cmdFleetQueueAge).toBe('function');
});
