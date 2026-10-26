import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

const mocks = vi.hoisted(() => ({
  build: vi.fn(), write: vi.fn(), telemetry: vi.fn(), config: vi.fn(),
}));
const snapshot = { schema: 'fleet.v1', generated_at: '2026-10-26T12:00:00.000Z', pools: [] };
vi.mock('../src/core/fleet/coding-snapshot.js', () => ({
  buildCodingFleetSnapshot: mocks.build,
  writeCodingFleetSnapshot: mocks.write,
  formatCodingFleetSnapshot: () => 'fleet published',
}));
vi.mock('../src/core/fleet/coding-telemetry.js', () => ({ emitFleetTelemetry: mocks.telemetry }));
vi.mock('../src/core/providers/coding-cli/scheduler/defaults.js', () => ({ loadSchedulerConfig: mocks.config }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.build.mockResolvedValue(snapshot);
  mocks.config.mockReturnValue({ posthog: { enabled: false, host: null, apiKey: null } });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet snapshot publication', () => {
  it.each(['config', 'telemetry'] as const)('reports a published snapshot when %s fails', async (failure) => {
    mocks[failure].mockImplementation(() => { throw new Error('private-error-canary'); });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--json'])).toBe(0);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify(snapshot, null, 2) + '\n');
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(['build', 'write'] as const)('refuses publication and telemetry when %s fails without exposing the error', async (failure) => {
    mocks[failure].mockImplementation(() => { throw new Error('private-error-canary'); });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--json'])).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('snapshot unavailable'));
    expect(stderr.mock.calls.flat().join('')).not.toContain('private-error-canary');
    expect(mocks.telemetry).not.toHaveBeenCalled();
  });
});
