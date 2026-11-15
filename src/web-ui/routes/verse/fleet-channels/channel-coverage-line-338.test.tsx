import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { channelCoverageLine, narrowChannelHealth } from './channel-health-model.js';
import { ChannelHealthStrip } from './ChannelHealthStrip.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-13T12:00:00Z');
const base = { configured: true, processAlive: true, runtimeHost: null, lastInboundAt: null, lastReplyAt: null, state: 'LIVE', unansweredCount: 0, missing: [] };
const rowOf = (over: Record<string, unknown>) => narrowChannelHealth({ channelHealth: { channels: [{ ...base, channel: 'slack', ...over }] } });
const first = (over: Record<string, unknown>) => { const v = rowOf(over); if (!v.available) throw new Error('unavailable'); return v.channels[0]!; };

describe('channelCoverageLine', () => {
  it('verified, with and without answeredCount', () => {
    expect(channelCoverageLine(first({ proof: { requestCoverage: 'verified' } }))).toBe('requests answered in thread');
    expect(channelCoverageLine(first({ proof: { requestCoverage: 'verified', answeredCount: 4 } }))).toBe('requests answered in thread (4)');
  });
  it('unproven uses unansweredCount and pluralizes', () => {
    expect(channelCoverageLine(first({ unansweredCount: 2, proof: { requestCoverage: 'unproven' } }))).toBe('2 requests waiting, no reply receipt bound');
    expect(channelCoverageLine(first({ unansweredCount: 1, proof: { requestCoverage: 'unproven' } }))).toBe('1 request waiting, no reply receipt bound');
  });
  it('idle', () => {
    expect(channelCoverageLine(first({ proof: { requestCoverage: 'idle' } }))).toBe('no request in the last hour, LIVE shows process and config only');
  });
  it('missing or unrecognised proof is unknown with a null line', () => {
    expect(first({}).coverage).toBe('unknown');
    expect(channelCoverageLine(first({}))).toBeNull();
    expect(channelCoverageLine(first({ proof: { requestCoverage: 'bogus' } }))).toBeNull();
  });
  it.each([-1, NaN, '3', 1.5])('ignores malformed answeredCount %s', bad => {
    const r = first({ proof: { requestCoverage: 'verified', answeredCount: bad } });
    expect(r.answeredCount).toBeNull();
    expect(channelCoverageLine(r)).toBe('requests answered in thread');
  });
  it('appends durable ingress failures only when failed > 0', () => {
    const ingress = (failed: number) => ({ posted: 1, duplicate: 0, failed, unverified: 0 });
    expect(channelCoverageLine(first({ proof: { requestCoverage: 'verified', answeredCount: 2, durableIngress: ingress(3) } })))
      .toBe('requests answered in thread (2); durable ingress failed 3');
    expect(channelCoverageLine(first({ proof: { requestCoverage: 'idle', durableIngress: ingress(0) } }))).not.toMatch(/ingress/);
    expect(first({ proof: { requestCoverage: 'idle', durableIngress: { posted: 1, failed: 'x' } } }).ingress).toBeNull();
  });
});

describe('ChannelHealthStrip coverage', () => {
  it('shows waiting text for slack unproven and nothing for iMessage without proof', () => {
    const health = narrowChannelHealth({ channelHealth: { channels: [
      { ...base, channel: 'slack', unansweredCount: 2, proof: { requestCoverage: 'unproven' } },
      { ...base, channel: 'imessage' }] } });
    render(<ChannelHealthStrip health={health} nowMs={NOW} />);
    expect(screen.getByText('2 requests waiting, no reply receipt bound')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-coverage-imessage')).toBeNull();
  });
});
