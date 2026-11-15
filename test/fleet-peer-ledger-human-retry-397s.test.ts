import { expect, it, vi } from 'vitest';
import { cmdFleetPeerLedger } from '../src/cli/fleet-peer-ledger.js';
import type { PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';

it('shows observed retry evidence only for blocked pairs and preserves JSON', async () => {
  const report: PeerLedgerReport = { v: 1, authority: 'none', status: 'ok', asOf: '2026-11-13T12:00:00.000Z',
    liveRows: 8, capacity: 1024, windowMs: 60000, pairLimit: 6, maxHops: 3,
    pairs: [
      { fromAgent: 'fake-a', target: 'fake-b', inWindow: 6, remaining: 0, lastAt: '2026-11-13T11:59:59.000Z', retryAt: '2026-11-13T12:00:30.000Z' },
      { fromAgent: 'fake-a', target: 'fake-c', inWindow: 2, remaining: 4, lastAt: '2026-11-13T11:59:59.000Z', retryAt: '2026-11-13T12:00:45.000Z' },
      { fromAgent: 'fake-a', target: 'fake-d', inWindow: 6, remaining: 0, lastAt: '2026-11-13T11:59:59.000Z', retryAt: null },
    ], origins: [], truncated: { pairs: false, origins: false } };
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { output += String(s); return true; });
  const run = async (value: PeerLedgerReport, args: string[] = []) => {
    output = '';
    const code = await cmdFleetPeerLedger(args, { read: () => value });
    return { code, text: output };
  };
  try {
    const human = await run(report);
    expect(human.code).toBe(0);
    expect(human.text).toContain(`as of: ${report.asOf}`);
    expect(human.text).toContain('fake-a -> fake-b  6/6  remaining 0  blocked; retry at: 2026-11-13T12:00:30.000Z');
    expect(human.text).toContain('fake-a -> fake-c  2/6  remaining 4\n');
    expect(human.text).not.toContain('2026-11-13T12:00:45.000Z');
    expect(human.text).toContain('fake-a -> fake-d  6/6  remaining 0  blocked; retry at: unknown');
    expect((await run(report, ['--json'])).text).toBe(JSON.stringify(report, null, 2) + '\n');
    const empty = await run({ ...report, status: 'empty', pairs: [], liveRows: 0 });
    expect(empty.code).toBe(0);
    expect(empty.text).toContain(`as of: ${report.asOf}`);
    expect(empty.text).not.toContain('retry at:');
    const unavailable = await run({ ...report, status: 'unavailable', reason: 'fixture', pairs: [] });
    expect(unavailable.code).toBe(1);
    expect(unavailable.text).toContain(`as of: ${report.asOf}`);
    expect(unavailable.text).not.toContain('retry at:');
  } finally { write.mockRestore(); }
});
