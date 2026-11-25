import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reader, send } = vi.hoisted(() => ({ reader: vi.fn(), send: vi.fn() }));
vi.mock('../src/core/comms/imessage-ack-evidence.js', () => ({ readImessageAckEvidence: reader }));
vi.mock('../src/core/config.js', () => ({ loadConfigReadOnlyStrict: () => ({}) }));
vi.mock('../src/core/integrations/imessage.js', () => ({ commsEnabled: () => true, readLastSend: send }));
vi.mock('node:child_process', () => ({ execFile: (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null) => void) => cb(null) }));

import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = '2026-11-13T18:00:00.000Z';
const recent = '2026-11-13T17:55:00.000Z';
const slack: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
const report = async () => (await readChannelHealth({ now: () => new Date(now), host: 'fake-host', runsDir: '/fake-runs', sources: { slack } })).channels[1]!;

beforeEach(() => {
  reader.mockReset().mockResolvedValue({ sourceState: 'ok', rows: [], malformedRows: 0 });
  send.mockReset().mockReturnValue(null);
});

describe('default iMessage outbound failure evidence', () => {
  it('degrades an idle bridge without exposing the error', async () => {
    send.mockReturnValue({ ok: false, at: recent, errorCode: 'private-error-payload' });
    const channel = await report();
    expect(channel).toMatchObject({ state: 'DEGRADED', lastReplyAt: null, unansweredCount: 0,
      missing: ['imessage outbound send failed'], proof: { requestCoverage: 'idle' } });
    expect(JSON.stringify(channel)).not.toContain('private-error-payload');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('/fake-runs');
  });

  it('does not clear a pending inbound request', async () => {
    reader.mockResolvedValue({ sourceState: 'ok', rows: [{ timestamp: '2026-11-13T17:40:00.000Z', status: 'accepted' }], malformedRows: 0 });
    send.mockReturnValue({ ok: false, at: recent });
    expect(await report()).toMatchObject({ state: 'DEGRADED', unansweredCount: 1, lastReplyAt: null,
      missing: ['imessage outbound send failed'], proof: { requestCoverage: 'unproven' } });
  });

  it('treats success as activity, not request coverage', async () => {
    reader.mockResolvedValue({ sourceState: 'ok', rows: [{ timestamp: recent, status: 'accepted' }], malformedRows: 0 });
    send.mockReturnValue({ ok: true, at: recent });
    expect(await report()).toMatchObject({ lastReplyAt: recent, unansweredCount: 1, proof: { requestCoverage: 'unproven' } });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([['old failure', { ok: false, at: '2026-11-13T16:59:00.000Z' }], ['missing receipt', null]])(
    'keeps idle behavior for %s', async (_label, receipt) => {
      send.mockReturnValue(receipt);
      expect(await report()).toMatchObject({ state: 'LIVE', missing: [], lastReplyAt: null });
    },
  );

  it.each(['2026-11-13T18:01:00.000Z', 'malformed'])('reports invalid failure time %s as unknown', async (at) => {
    send.mockReturnValue({ ok: false, at, errorCode: 'private-error-payload' });
    const channel = await report();
    expect(channel).toMatchObject({ state: 'UNKNOWN', lastReplyAt: null, missing: ['imessage outbound failure evidence time invalid'] });
    expect(JSON.stringify(channel)).not.toContain('private-error-payload');
  });

  it('preserves inbound store UNKNOWN over a recent failure', async () => {
    reader.mockResolvedValue({ sourceState: 'unreadable', rows: [], malformedRows: 0 });
    send.mockReturnValue({ ok: false, at: recent });
    expect(await report()).toMatchObject({ state: 'UNKNOWN', missing: ['imessage receipt source unreadable'] });
  });
});
