import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(), enabled: vi.fn(), sample: vi.fn(),
}));
vi.mock('../src/core/config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(), loadConfig: mocks.loadConfig,
}));
vi.mock('../src/core/resources/telemetry-store.js', () => ({
  machineTelemetryEnabled: mocks.enabled, sampleMachineForDispatch: mocks.sample,
}));

import { cmdResources } from '../src/cli/resources.js';
import { getResourceSnapshot } from '../src/core/fabric/resource-monitor.js';

beforeEach(() => {
  mocks.loadConfig.mockReset().mockReturnValue({ telemetry: { machine: { enabled: true } } });
  mocks.enabled.mockReset().mockReturnValue(true);
  mocks.sample.mockReset().mockResolvedValue({ schemaVersion: 1, headroom: 3, gpuPercent: null, anePercent: null });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('resources sample CLI', () => {
  it.each([
    ['sample', '--sudo'], ['sample', '--json', '--json'], ['sample', '--bind', '0.0.0.0'],
    ['sample', '--url', 'https://TEST.example'], ['sample', '--watch'],
  ])('rejects unknown or repeated arguments before reading configuration: %j', async (...args) => {
    expect(await cmdResources(args)).toBe(2);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.sample).not.toHaveBeenCalled();
  });

  it('prints sample help without collecting telemetry or reading config', async () => {
    expect(await cmdResources(['sample', '--help'])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('telemetry.machine.enabled'));
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.sample).not.toHaveBeenCalled();
  });

  it('refuses disabled configuration without invoking the sampler', async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await cmdResources(['sample', '--json'])).toBe(2);
    expect(mocks.sample).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('prints exactly one machine-readable observation on success', async () => {
    expect(await cmdResources(['sample', '--json'])).toBe(0);
    expect(mocks.sample).toHaveBeenCalledWith({ telemetry: { machine: { enabled: true } } });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({
      schemaVersion: 1, headroom: 3, gpuPercent: null, anePercent: null,
    });
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('reports inaccessible configuration without exposing error contents', async () => {
    const privateValue = ['TEST', 'PRIVATE', 'ERROR'].join('-');
    mocks.loadConfig.mockImplementation(() => { throw new Error(privateValue); });
    expect(await cmdResources(['sample', '--json'])).toBe(1);
    expect(mocks.sample).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain(privateValue);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('returns failure without partial JSON when fleet persistence fails', async () => {
    mocks.sample.mockResolvedValue(null);
    expect(await cmdResources(['sample', '--json'])).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });
});

describe('dispatch resource integration', () => {
  it('refreshes machine telemetry on every resource read even while provider state is cached', async () => {
    const config = { telemetry: { machine: { enabled: true } }, foundry: { allowedBackends: ['builtin'] } };
    const first = await getResourceSnapshot(config);
    const second = await getResourceSnapshot(config);
    expect(first.backends.map(backend => backend.backend)).toEqual(['builtin']);
    expect(second).toBe(first);
    expect(mocks.sample).toHaveBeenCalledTimes(2);
    expect(mocks.sample).toHaveBeenNthCalledWith(1, config);
    expect(mocks.sample).toHaveBeenNthCalledWith(2, config);
  });
});
