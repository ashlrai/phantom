import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { refreshLoopReport } from '../src/core/fleet/loop-report.js';
import { loopCosts } from '../src/core/fleet/loop-inputs.js';
import { LOOP_REPOS, summarizeLoop } from '../src/core/fleet/loop.js';

vi.mock('../src/core/fleet/loop-report.js', () => ({ refreshLoopReport: vi.fn() }));
const now = Date.parse('2026-10-26T12:00:00Z');
function report() {
  return summarizeLoop(now, [], [], LOOP_REPOS.map(repo => ({ repo, complete: true, merged_prs: 0 })), loopCosts({}, [], now).cost);
}
describe('phm fleet loop CLI dispatch', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(process.stderr, 'write').mockImplementation(() => true); vi.mocked(refreshLoopReport).mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('dispatches the real fleet verb and emits exactly one loop.v1 JSON object', async () => {
    vi.mocked(refreshLoopReport).mockResolvedValue(report());
    expect(await cmdFleet(['loop', '--json'])).toBe(0);
    expect(refreshLoopReport).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0])).toMatchObject({ schema: 'loop.v1', panel: { stages: expect.any(Array) } });
  });
  it('preserves partial JSON with a nonzero exit code', async () => {
    vi.mocked(refreshLoopReport).mockResolvedValue({ ...report(), complete: false });
    expect(await cmdFleet(['loop', '--json'])).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0]).complete).toBe(false);
  });
  it('returns a nonzero exit code for configured telemetry failures', async () => {
    vi.mocked(refreshLoopReport).mockResolvedValue({ ...report(), telemetry: 'failed' });
    expect(await cmdFleet(['loop', '--json'])).toBe(1);
  });
  it('keeps --help side-effect free', async () => {
    expect(await cmdFleet(['loop', '--help'])).toBe(0);
    expect(refreshLoopReport).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('fleet loop [--json]');
  });
  it('rejects unknown options and extra positionals before refreshing', async () => {
    expect(await cmdFleet(['loop', '--jsno'])).toBe(2);
    expect(await cmdFleet(['loop', 'extra'])).toBe(2);
    expect(refreshLoopReport).not.toHaveBeenCalled();
  });
  it('redacts raw failures while preserving machine-readable JSON', async () => {
    vi.mocked(refreshLoopReport).mockRejectedValue(new Error('private-fixture-token'));
    expect(await cmdFleet(['loop', '--json'])).toBe(1);
    const output = vi.mocked(console.log).mock.calls[0]?.[0] as string;
    expect(JSON.parse(output).schema).toBe('loop.v1');
    expect(output).not.toContain('private-fixture-token');
  });
});
