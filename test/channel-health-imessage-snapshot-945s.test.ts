import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AckEvidence } from '../src/core/comms/imessage-ack-evidence.js';

const reader = vi.hoisted(() => vi.fn());
vi.mock('../src/core/comms/imessage-ack-evidence.js', () => ({ readImessageAckEvidence: reader }));

import { defaultChannelSources } from '../src/core/fleet/channel-health.js';

const at = '2026-11-13T17:55:00.000Z';
const nextAt = '2026-11-13T17:59:00.000Z';
const generation = (timestamp = at): AckEvidence => ({
  sourceState: 'ok', malformedRows: 0, deliveryProof: false,
  rows: [
    { timestamp, rowid: 1, status: 'accepted', delivery: 'unknown' },
    { timestamp: nextAt, rowid: 2, status: 'duplicate', delivery: 'unknown' },
  ],
});
const source = () => defaultChannelSources('/fake-runs').imessage;

beforeEach(() => reader.mockReset());

describe('default iMessage inbound evidence snapshot', () => {
  it('shares one lazy generation across projections and refreshes in a fresh factory', async () => {
    reader.mockResolvedValueOnce(generation()).mockResolvedValueOnce(generation(nextAt));
    const first = source();
    expect(reader).not.toHaveBeenCalled();
    expect(await first.inbound()).toEqual([at]);
    expect(await first.inboundEvidence!()).toEqual({ store: 'ok', rows: [{ at }] });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(4096, '/fake-runs');
    const fresh = source();
    expect(await fresh.inboundEvidence!()).toEqual({ store: 'ok', rows: [{ at: nextAt }] });
    expect(await fresh.inbound()).toEqual([nextAt]);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('shares the pending promise during concurrent projection access', async () => {
    let resolve!: (value: AckEvidence) => void;
    reader.mockReturnValueOnce(new Promise<AckEvidence>((done) => { resolve = done; }))
      .mockResolvedValue(generation(nextAt));
    const current = source();
    const rich = current.inboundEvidence!();
    const legacy = current.inbound();
    resolve(generation());
    expect(await Promise.all([legacy, rich])).toEqual([[at], { store: 'ok', rows: [{ at }] }]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it.each(['unreadable', 'malformed'] as const)('retains %s uncertainty until a fresh factory', async (state) => {
    const first = generation();
    if (state === 'unreadable') { first.sourceState = 'unreadable'; first.rows = []; }
    else first.malformedRows = 1;
    reader.mockResolvedValueOnce(first).mockResolvedValueOnce(generation(nextAt));
    const current = source();
    await expect(current.inbound()).rejects.toThrow('imessage-acks-unreadable');
    expect(await current.inboundEvidence!()).toEqual({ store: 'unreadable',
      rows: state === 'malformed' ? [{ at }] : [] });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(await source().inboundEvidence!()).toEqual({ store: 'ok', rows: [{ at: nextAt }] });
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
