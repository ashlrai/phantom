import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  open: vi.fn(), emit: vi.fn(), getSink: vi.fn(), close: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ open: mocks.open }));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({ telemetry: { pulse: 'https://analytics.example/otlp' } }) }));
vi.mock('../src/core/observability/telemetry-sink.js', () => ({ getSink: mocks.getSink }));
import { cmdPulse } from '../src/cli/pulse.js';
import { cmdPulseMemory } from '../src/cli/pulse-memory.js';

function file(contents: string, regular = true) {
  let offset = 0;
  const source = Buffer.from(contents);
  mocks.open.mockResolvedValue({
    stat: async () => ({ isFile: () => regular }), close: mocks.close,
    read: async (buffer: Buffer, position: number, length: number) => {
      // Deliberate short reads exercise the bounded-reader loop.
      const count = Math.min(length, source.length - offset, 31);
      source.copy(buffer, position, offset, offset + count); offset += count;
      return { bytesRead: count };
    },
  });
}
const input = JSON.stringify([{ jobId: 'job-1', samples: [{ rssBytes: 1048576, memguard: 'PAUSE' }] }]);
describe('phm pulse memory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getSink.mockReturnValue({ emit: mocks.emit });
    mocks.emit.mockResolvedValue({ sink: 'otlp', ok: true, detail: 'HTTP 200' });
    file(input);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
  it('dispatches through phm pulse and reports without analytics side effects', async () => {
    expect(await cmdPulse(['memory', '--samples', 'samples.json'])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('peak RSS 1.0 MiB'));
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.getSink).not.toHaveBeenCalled();
  });
  it('sends job metrics via the existing sink and provides machine-readable delivery status', async () => {
    expect(await cmdPulseMemory(['--samples', 'samples.json', '--json', '--send'])).toBe(0);
    expect(mocks.getSink).toHaveBeenCalledWith(expect.any(Object), false);
    expect(mocks.emit).toHaveBeenCalledWith([expect.objectContaining({ memory: { scope: 'job', peakRssBytes: 1048576, sampleCount: 1, pauseEvents: 1 } })]);
    const result = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
    expect(result.delivery).toEqual({ sink: 'otlp', ok: true });
  });
  it('returns failure when analytics is unavailable without echoing transport detail', async () => {
    mocks.emit.mockResolvedValue({ sink: 'otlp', ok: false, detail: 'PRIVATE_DETAIL' });
    expect(await cmdPulseMemory(['--samples', 'x', '--send'])).toBe(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('PRIVATE_DETAIL');
  });
  it('rejects invalid arguments before reading and help is side effect free', async () => {
    for (const args of [[], ['--send'], ['--samples', '--json'], ['--samples', 'a', '--samples', 'b'], ['--unknown']]) {
      expect(await cmdPulseMemory(args)).toBe(2);
    }
    expect(await cmdPulseMemory(['--help'])).toBe(0);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('closes invalid inputs and suppresses file contents and paths', async () => {
    file('PRIVATE_CONTENT');
    expect(await cmdPulseMemory(['--samples', '/PRIVATE_PATH'])).toBe(1);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/PRIVATE_CONTENT|PRIVATE_PATH/);
  });
  it('rejects non-regular files and closes the handle', async () => {
    file(input, false);
    expect(await cmdPulseMemory(['--samples', 'directory'])).toBe(1);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('bounds the actual read even if file metadata underreports the size', async () => {
    const read = vi.fn(async (_buffer: Buffer, _position: number, length: number) => ({ bytesRead: length }));
    mocks.open.mockResolvedValue({ stat: async () => ({ isFile: () => true, size: 1 }), read, close: mocks.close });
    expect(await cmdPulseMemory(['--samples', 'growing-file'])).toBe(1);
    expect(read).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('does not leak thrown transport details', async () => {
    mocks.emit.mockRejectedValue(new Error('PRIVATE_TRANSPORT'));
    expect(await cmdPulseMemory(['--samples', 'x', '--send'])).toBe(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE_TRANSPORT');
  });
});
