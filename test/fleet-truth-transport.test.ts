import { expect, it, vi } from 'vitest';

const port = vi.hoisted(() => ({ clock: 0, calls: [] as Array<{ timeout: number; killSignal: string; args: string[] }> }));
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], options: { timeout: number; killSignal: string }, callback: (error: Error | null, stdout: string) => void) => {
    port.calls.push({ timeout: options.timeout, killSignal: options.killSignal, args });
    const page = port.calls.length;
    const rows = Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
      repository_url: 'https://api.github.com/repos/ashlrai/phantom', number: (page - 1) * 100 + i + 1,
      title: 'fixture', pull_request: { merged_at: '2026-11-07T02:43:07Z' },
    }));
    if (page === 1) port.clock = 12_000;
    callback(null, JSON.stringify({ total_count: 101, incomplete_results: false, items: rows }));
  },
}));
import { getFleetTruth } from '../src/core/fleet/fleet-truth.js';

it('bounds each real gh process by the remaining shared deadline and a terminating signal', async () => {
  port.clock = 0; port.calls.length = 0;
  const prior = process.env['ASHLR_FLEET_TRUTH_GH']; delete process.env['ASHLR_FLEET_TRUTH_GH'];
  try {
    const result = await getFleetTruth(Date.parse('2026-11-07T02:42:30Z'), {
      nowMs: Date.parse('2026-11-07T02:43:30Z'), fresh: true, monotonicNow: () => port.clock,
      ledgerMerges: () => [], runsDir: '/nonexistent-merge-transport-fixture', liveWorkers: async () => null,
    });
    expect(result.mergeCountState).toBe('ok'); expect(result.merged).toHaveLength(101);
    expect(port.calls.map(call => [call.timeout, call.killSignal])).toEqual([[30_000, 'SIGKILL'], [18_000, 'SIGKILL']]);
    expect(port.calls.map(call => call.args.at(-1))).toEqual(['page=1', 'page=2']);
  } finally {
    if (prior === undefined) delete process.env['ASHLR_FLEET_TRUTH_GH']; else process.env['ASHLR_FLEET_TRUTH_GH'] = prior;
  }
});
