import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowChannelHealth } from './channel-health-model.js';
import { ChannelHealthStrip } from './ChannelHealthStrip.js';

afterEach(cleanup);
const asOf = '2026-11-25T12:00:00.000Z';
function show(over: Record<string, unknown> = {}, requestCoverage = 'idle') {
  const health = narrowChannelHealth({ channelHealth: { schemaVersion: 1, asOf, channels: [{
    channel: 'slack', configured: true, processAlive: true, runtimeHost: 'test-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, state: 'LIVE', missing: [], asOf,
    proof: { requestCoverage, futureDatedCount: 0 }, ...over,
  }] } });
  if (!health.available) throw new Error('expected report');
  render(<ChannelHealthStrip health={health} nowMs={Date.parse(asOf)} />);
  expect(screen.getByText(/^as of \d{2}:\d{2}/)).toBeInTheDocument();
  return health.channels[0]!;
}

it.each([
  { state: 'UNKNOWN', missing: ['slack inbound journal missing'] },
  { state: 'UNKNOWN', missing: ['slack receipt source unreadable'] },
  { state: 'BLOCKED', processAlive: false, missing: ['slack bridge process not running'] },
  { state: 'BLOCKED', configured: false, processAlive: 'unknown', missing: ['slack config not configured'] },
  { state: 'UNKNOWN', configured: false, missing: ['slack configuration unreadable'] },
])('keeps unavailable source unknown: %j', over => {
  expect(show(over)).toMatchObject({ unansweredCount: null, coverage: 'unknown', missing: over.missing });
  expect(screen.getByText('request count unknown')).toBeInTheDocument();
  expect(screen.getByText('request coverage unknown')).toBeInTheDocument();
  expect(screen.getByText(new RegExp(over.missing[0]!))).toBeInTheDocument();
  expect(screen.queryByText(/0 requests waiting|no request in the last hour|\d+ unanswered/)).toBeNull();
});

it.each([undefined, null, -1, 1.5, NaN, Infinity, -Infinity, '0', true, {}])('keeps invalid count %j unknown', unansweredCount => {
  expect(show({ unansweredCount })).toMatchObject({ unansweredCount: null, coverage: 'unknown' });
  expect(screen.getByText('request count unknown')).toBeInTheDocument();
  expect(screen.queryByText(/0 requests waiting|no request in the last hour|\d+ unanswered/)).toBeNull();
});

it('does not interpolate a missing count into pending coverage', () => {
  expect(show({ unansweredCount: undefined }, 'unproven').unansweredCount).toBeNull();
  expect(screen.getByText('request count unknown, no reply receipt bound')).toBeInTheDocument();
  expect(screen.queryByText(/null|0 requests waiting|\d+ unanswered/)).toBeNull();
});

it.each([
  {}, { state: 'UNKNOWN', processAlive: 'unknown', missing: ['slack process liveness unverifiable'] },
])('retains known zero idle with usable observations: %j', over => {
  expect(show(over)).toMatchObject({ unansweredCount: 0, coverage: 'idle' });
  expect(screen.getByText(/no request in the last hour, LIVE shows process and config only/)).toBeInTheDocument();
});

it.each([
  {}, { state: 'UNKNOWN', missing: ['slack reply binding unreadable'] },
  { state: 'UNKNOWN', missing: ['slack inbound journal missing'] },
])('retains positive pending observations: %j', over => {
  expect(show({ unansweredCount: 2, lastInboundAt: '2026-11-25T11:55:00.000Z', ...over }, 'unproven'))
    .toMatchObject({ unansweredCount: 2, coverage: 'unproven', lastInboundAt: '2026-11-25T11:55:00.000Z' });
  expect(screen.getByText('2 unanswered')).toBeInTheDocument();
  expect(screen.getByText('2 requests waiting, no reply receipt bound')).toBeInTheDocument();
});

it('retains verified reply receipts', () => {
  expect(show({ proof: { requestCoverage: 'verified', answeredCount: 1, futureDatedCount: 0 } }))
    .toMatchObject({ unansweredCount: 0, coverage: 'verified', answeredCount: 1 });
  expect(screen.getByText('requests answered in thread (1)')).toBeInTheDocument();
});

it.each(['imessage inbound journal missing', 'imessage receipt source unreadable'])('masks iMessage %s', reason => {
  expect(show({ channel: 'imessage', state: 'UNKNOWN', missing: [reason] }))
    .toMatchObject({ unansweredCount: null, coverage: 'unknown', missing: [reason] });
  expect(screen.getByText('request count unknown')).toBeInTheDocument();
  expect(screen.getByText('request coverage unknown')).toBeInTheDocument();
  expect(screen.queryByText(/0 requests waiting|no request in the last hour|\d+ unanswered/)).toBeNull();
});
