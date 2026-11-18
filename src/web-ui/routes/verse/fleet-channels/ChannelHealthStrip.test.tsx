import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowChannelHealth } from './channel-health-model.js';
import { ChannelHealthStrip } from './ChannelHealthStrip.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-13T12:00:00Z');
const base = { configured: true, processAlive: true, runtimeHost: null, lastInboundAt: null, unansweredCount: 0, missing: [] };

it('shows missing names for a BLOCKED channel and the unanswered count', () => {
  const health = narrowChannelHealth({ channelHealth: { asOf: '2026-11-13T12:00:00Z', channels: [
    { ...base, channel: 'imessage', state: 'BLOCKED', lastReplyAt: null, unansweredCount: 3, missing: ['bridge process', 'config.imessage'] }] } });
  render(<ChannelHealthStrip health={health} nowMs={NOW} />);
  expect(screen.getByText('iMessage BLOCKED: missing bridge process, config.imessage')).toBeInTheDocument();
  expect(screen.getByText('BLOCKED')).toBeInTheDocument();
  expect(screen.getByText('3 unanswered')).toBeInTheDocument();
  expect(screen.getByText(/^as of \d{2}:\d{2}/)).toBeInTheDocument();
});

it('shows last reply age for a LIVE channel and no unanswered chip', () => {
  const health = narrowChannelHealth({ channelHealth: { asOf: '2026-11-13T12:00:00Z', channels: [
    { ...base, channel: 'slack', state: 'LIVE', lastReplyAt: '2026-11-13T11:56:00Z' }] } });
  render(<ChannelHealthStrip health={health} nowMs={NOW} />);
  expect(screen.getByText('Slack LIVE, last reply 4m ago')).toBeInTheDocument();
  expect(screen.queryByText(/unanswered/)).toBeNull();
});

it('shows the unavailable line', () => {
  render(<ChannelHealthStrip health={{ available: false }} nowMs={NOW} />);
  expect(screen.getByText('Channel health not available on this build')).toBeInTheDocument();
});
