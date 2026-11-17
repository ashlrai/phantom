import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import * as runtime from '../src/core/fleet/runtime-snapshot.js';
import { formatRuntimeStatusLines } from '../src/core/fleet/runtime-status-lines.js';

vi.mock('../src/core/leader/status-digest-sources.js', () => ({ gatherStatusDigestInput: vi.fn() }));
vi.mock('../src/core/leader/status-digest.js', () => ({ buildStatusDigest: () => ['Shipped: none'] }));
afterEach(() => vi.restoreAllMocks());

const now = new Date('2026-11-14T20:00:12Z');
const snapshot: runtime.RuntimeSnapshot = {
  host: 'host-fake', tailnetName: 'tailnet-fake', installedVersion: '1.0.0', sourceVersion: '1.0.1',
  pid: 123, uptimeSeconds: 10, platform: 'fake', arch: 'fake', stateRoot: '/fake/private/state',
  lastFleetStateRead: { mtime: '2026-11-14T20:00:00Z', ageSeconds: 12 },
  coordination: { state: 'known', activeClaims: 3, newestReturnAgeSeconds: 7 },
  asOf: now.toISOString(), reasons: [],
};
const board = () => ({ items: [], inbox: 'ok' as const, truncated: false });
const brief = async () => 'Morning leader brief\nShipped: none';

describe('Slack status runtime snapshot', () => {
  it('appends the injected snapshot through the real Slack reply builder', async () => {
    const read = vi.fn(async () => snapshot);
    const reply = ownerStatusReply({ brief, board, snapshot: read });
    expect(reply.ask('Phantom status')).toBe(true);
    const text = await reply.compose('/fake/runs', now, 'Phantom status');
    expect(text).toContain('Phantom status, 15:00 ET\nShipped: none');
    expect(text.endsWith(formatRuntimeStatusLines(snapshot).join('\n'))).toBe(true);
    expect(text).not.toContain(snapshot.stateRoot);
    expect(read).toHaveBeenCalledExactlyOnceWith(now);
  });

  it('uses the live snapshot reader by default with the reply clock', async () => {
    const read = vi.spyOn(runtime, 'readRuntimeSnapshot').mockResolvedValue(snapshot);
    const text = await ownerStatusReply({ board }).compose('/fake/runs', now, 'status');
    expect(text).toContain(formatRuntimeStatusLines(snapshot).join('\n'));
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]![0].now()).toBe(now.getTime());
  });

  it('still replies when the snapshot reader throws, without exposing the error', async () => {
    const reply = ownerStatusReply({ brief, board, snapshot: async () => { throw new Error('private fake detail'); } });
    const text = await reply.compose('/fake/runs', now, 'status');
    expect(text).toContain('Shipped: none');
    expect(text.endsWith('\nRuntime: UNKNOWN (snapshot unavailable)')).toBe(true);
    expect(text).not.toContain('private fake detail');
  });

  it('preserves the snapshot within the reply cap even for an oversized digest', async () => {
    const reply = ownerStatusReply({ brief: async () => `Morning leader brief\n${'x'.repeat(3000)}`, board, snapshot: async () => snapshot });
    const text = await reply.compose('/fake/runs', now, 'status');
    expect(text).toHaveLength(1500);
    expect(text.endsWith(formatRuntimeStatusLines(snapshot).join('\n'))).toBe(true);
  });
});
