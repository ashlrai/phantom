import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAppsWatchPublisher, type AppsWatchEvent } from '../src/core/fleet/apps-watch-bus.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

type Observation = Extract<AppsWatchEvent, { kind: 'apps-watch.observation.v1' }>;
const observation = (cycle: number, changes: Partial<Observation> = {}): Observation => ({
  kind: 'apps-watch.observation.v1', cycle, healthy: true, recoveries: 0,
  consecutiveFailures: 0, totalFailedCycles: 0,
  observedState: [{ app: 'alpha', observedRunning: true }, { app: 'beta', observedRunning: false }], ...changes,
});
const summary: AppsWatchEvent = { kind: 'apps-watch.summary.v1', apps: ['alpha', 'beta'], outcome: 'completed',
  cycles: 500, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, lastObservedState: null };

it('coalesces equivalent states but publishes changes, recoveries and the summary', () => {
  const append = vi.fn<typeof appendBusInbox>(() => ({ status: 'posted', id: 'fake', cursor: 1 }));
  const publish = createAppsWatchPublisher('/fake', append);
  const first = observation(1);
  expect(publish(first)).toBe(true);
  for (let i = 2; i <= 501; i++) expect(publish(observation(i, { totalFailedCycles: i }))).toBe(true);
  const reversed = [...first.observedState!].reverse();
  expect(publish(observation(502, { observedState: reversed }))).toBe(true);
  expect(first.observedState?.map(row => row.app)).toEqual(['alpha', 'beta']);
  expect(append).toHaveBeenCalledTimes(1);
  expect(publish(observation(503, { observedState: null }))).toBe(true);
  expect(publish(observation(504, { observedState: [] }))).toBe(true);
  expect(publish(observation(505, { healthy: false }))).toBe(true);
  expect(publish(observation(506, { healthy: false, recoveries: 1 }))).toBe(true);
  expect(publish(observation(507, { healthy: false, recoveries: 1 }))).toBe(true);
  expect(publish(summary)).toBe(true);
  expect(append).toHaveBeenCalledTimes(7);
});

it('retries failed observations, attempts summaries after failures, and isolates publishers', () => {
  const append = vi.fn<typeof appendBusInbox>()
    .mockReturnValueOnce({ status: 'retryable' })
    .mockReturnValue({ status: 'posted', id: 'fake', cursor: 1 });
  const first = createAppsWatchPublisher('/first', append);
  const second = createAppsWatchPublisher('/second', append);
  expect(first(observation(1))).toBe(false);
  expect(first(observation(2))).toBe(true);
  expect(first(observation(3))).toBe(true);
  expect(second(observation(1))).toBe(true);
  expect(append).toHaveBeenCalledTimes(3);
  expect(append.mock.calls.map(call => call[1]?.root)).toEqual(['/first', '/first', '/second']);
  const failing = vi.fn<typeof appendBusInbox>(() => { throw new Error('fake failure'); });
  const publish = createAppsWatchPublisher('/fake', failing);
  expect(publish(observation(1))).toBe(false);
  expect(publish(summary)).toBe(false);
  expect(failing).toHaveBeenCalledTimes(2);
});

it('keeps another agent message readable in the real isolated inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'apps-watch-bus-'));
  try {
    const publish = createAppsWatchPublisher(root);
    expect(publish(observation(1))).toBe(true);
    expect(appendBusInbox({ id: 'peer-message', from: 'agent-a', to: 'leaders', priority: 'P1', ttl: 60_000,
      body: 'real agent message' }, { root }).status).toBe('posted');
    for (let i = 2; i <= 1200; i++) expect(publish(observation(i))).toBe(true);
    expect(publish(summary)).toBe(true);
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('inbox unavailable');
    expect(page.messages.map(row => row.envelope.id)).toHaveLength(3);
    expect(page.messages.some(row => row.envelope.id === 'peer-message')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
