import { beforeEach, describe, expect, it, vi } from 'vitest';

const reader = vi.hoisted(() => vi.fn());
vi.mock('../src/core/comms/imessage-ack-evidence.js', () => ({ readImessageAckEvidence: reader }));
vi.mock('../src/core/config.js', () => ({ loadConfigReadOnlyStrict: () => ({}) }));
vi.mock('../src/core/integrations/imessage.js', () => ({ commsEnabled: () => true, readLastSend: () => null }));
vi.mock('node:child_process', () => ({ execFile: (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null) => void) => cb(null) }));

import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = '2026-11-13T18:00:00.000Z';
const at = '2026-11-13T17:55:00.000Z';
const slack: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
const evidence = (sourceState: string, rows: object[] = [], malformedRows = 0) =>
  ({ sourceState, rows, malformedRows, deliveryProof: false });
const report = () => readChannelHealth({ now: () => new Date(now), host: 'fake-host', runsDir: '/fake-runs', sources: { slack } });

beforeEach(() => reader.mockReset());

describe('default iMessage inbound store', () => {
  it.each([['missing', 'imessage inbound journal missing'], ['unreadable', 'imessage receipt source unreadable']])(
    'reports %s evidence as unknown', async (state, reason) => {
      reader.mockResolvedValue(evidence(state));
      const result = await report();
      expect(result.asOf).toBe(now);
      expect(result.channels[1]).toMatchObject({ asOf: now, state: 'UNKNOWN', configured: true,
        processAlive: true, runtimeHost: 'fake-host', missing: [reason] });
      expect(result.channels[1]!.proof.requestCoverage).not.toBe('verified');
      expect(reader).toHaveBeenCalledWith(4096, '/fake-runs');
    },
  );

  it('retains accepted observations but reports malformed coverage as unknown', async () => {
    reader.mockResolvedValue(evidence('ok', [{ timestamp: at, status: 'accepted' }], 1));
    const channel = (await report()).channels[1]!;
    expect(channel).toMatchObject({ state: 'UNKNOWN', lastInboundAt: at, unansweredCount: 1,
      missing: ['imessage receipt source unreadable'], proof: { requestCoverage: 'unproven' } });
    expect(channel.proof.durableIngress).toBeUndefined();
  });

  it('recovers on a fresh report when the journal becomes readable and empty', async () => {
    reader.mockResolvedValueOnce(evidence('missing')).mockResolvedValueOnce(evidence('ok'));
    expect((await report()).channels[1]!.state).toBe('UNKNOWN');
    expect((await report()).channels[1]).toMatchObject({ state: 'LIVE', asOf: now, missing: [],
      lastInboundAt: null, proof: { requestCoverage: 'idle' } });
  });

  it('counts accepted rows as unproven activity and ignores duplicates', async () => {
    reader.mockResolvedValue(evidence('ok', [{ timestamp: at, status: 'accepted' },
      { timestamp: '2026-11-13T17:59:00.000Z', status: 'duplicate' }]));
    const channel = (await report()).channels[1]!;
    expect(channel).toMatchObject({ state: 'LIVE', lastInboundAt: at, unansweredCount: 1,
      proof: { requestCoverage: 'unproven' } });
    expect(channel.proof.durableIngress).toBeUndefined();
  });
});
