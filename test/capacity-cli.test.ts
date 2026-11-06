import { afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ cycle: vi.fn(), stop: vi.fn(), load: vi.fn(() => ({})) }));
vi.mock('../src/core/config.js', () => ({ loadConfig: h.load }));
vi.mock('../src/core/daemon/capacity-publisher.js', () => ({
  createDaemonCapacityPublisher: () => ({ cycle: h.cycle, stop: h.stop }),
  defaultDaemonCapacityPublisherDeps: () => ({}),
}));
import { cmdCapacity } from '../src/cli/capacity.js';
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('capacity publish', () => {
  it.each(['published', 'published-shared', 'dormant', 'fresh', 'failed', 'sample-timeout', 'lease-held-elsewhere'])('reports %s with an actionable exit code and stops', async state => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const status = { state, reason: 'safe metadata', lastPublishedAt: null };
    h.cycle.mockResolvedValue(status);
    expect(await cmdCapacity(['publish', '--json'])).toBe(['published', 'published-shared', 'dormant', 'fresh'].includes(state) ? 0 : 1);
    expect(JSON.parse(out.mock.calls[0]![0])).toEqual(status);
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('rejects invalid arguments before collecting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdCapacity(['publish', '--force'])).toBe(2);
    expect(h.cycle).not.toHaveBeenCalled();
  });
  it('does not echo configuration exceptions', async () => {
    const out = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.load.mockImplementationOnce(() => { throw new Error('secret-canary'); });
    expect(await cmdCapacity(['publish', '--json'])).toBe(2);
    expect(out.mock.calls.flat().join()).not.toContain('secret-canary');
    expect(out.mock.calls.flat().join()).toContain('retry phm capacity publish');
  });
});
