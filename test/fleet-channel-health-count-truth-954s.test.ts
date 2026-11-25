import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetChannelHealth } from '../src/cli/fleet-channel-health.js';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-25T12:00:00.000Z');
const pending = '2026-11-25T11:55:00.000Z';
const source = (overrides: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...overrides,
});
const deps = (slack: ChannelSource) => ({ now: () => now, host: 'test-host', sources: { slack, imessage: source() } });

afterEach(() => vi.restoreAllMocks());

describe('channel health text request counts', () => {
  it.each([
    ['missing configuration', source({ configMissing: () => ['slack config'] })],
    ['unreadable configuration', source({ configMissing: () => { throw new Error('unavailable'); } })],
    ['stopped process', source({ processAlive: () => false })],
    ['unreadable receipts', source({ replies: () => { throw new Error('unavailable'); } })],
    ['missing inbound journal', source({ inboundEvidence: () => ({ store: 'missing', rows: [] }) })],
    ['unreadable inbound journal', source({ inboundEvidence: () => ({ store: 'unreadable', rows: [] }) })],
  ])('reports unknown for %s', async (_name, slack) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth([], deps(slack))).toBe(1);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines[1]).toContain('unanswered=unknown coverage=unknown');
    expect(lines[2]).toContain('missing:');
    expect(lines[1]).not.toContain('unanswered=0');
    expect(lines[1]).not.toContain('coverage=idle');
  });

  it('retains idle for readable empty evidence', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth([], deps(source()))).toBe(0);
    expect(log.mock.calls[1]?.[0]).toContain('unanswered=0 coverage=idle');
    expect(log.mock.calls[2]?.[0]).toContain('No request round trip');
  });

  it.each([
    ['unreadable binding', source({ inbound: () => [pending], replyBinding: () => { throw new Error('unavailable'); } }), 'reply binding unreadable'],
    ['unknown liveness', source({ processAlive: () => 'unknown', inbound: () => [pending] }), 'process liveness unverifiable'],
    ['missing journal with observations', source({ inboundEvidence: () => ({ store: 'missing', rows: [{ at: pending }] }) }), 'inbound journal missing'],
  ])('preserves pending observations with %s', async (_name, slack, reason) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth([], deps(slack))).toBe(1);
    expect(log.mock.calls[1]?.[0]).toContain(`lastInbound=${pending}`);
    expect(log.mock.calls[1]?.[0]).toContain('unanswered=1 coverage=unproven');
    expect(log.mock.calls[2]?.[0]).toContain(reason);
  });

  it('leaves the JSON report unchanged', async () => {
    const input = deps(source({ processAlive: () => false }));
    const expected = await readChannelHealth(input);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth(['--json'], input)).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(expected);
    expect(expected.channels[0]?.unansweredCount).toBe(0);
    expect(expected.channels[0]?.proof.requestCoverage).toBe('idle');
  });
});
