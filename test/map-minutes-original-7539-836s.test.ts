import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdMap, MAP_USAGE } from '../src/cli/map.js';

const { readMapEdges, formatMapEdgesText } = vi.hoisted(() => ({
  readMapEdges: vi.fn(), formatMapEdgesText: vi.fn(),
}));
vi.mock('../src/core/fleet/map-edges.js', () => ({ readMapEdges, formatMapEdgesText }));

const result = {
  schema: 'fleet.map-edges.v1', version: 1, source: 'available',
  edges: [{ from: 'fake-agent', to: 'fake-worker', lastSummary: 'hello' }],
};

describe('map edges minutes alias', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    readMapEdges.mockReset().mockReturnValue(result);
    formatMapEdgesText.mockReset().mockReturnValue('fake-agent -> fake-worker: hello');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes minutes to the existing reader and prints its text', async () => {
    expect(MAP_USAGE).toContain('--minutes <n>');
    expect(await cmdMap(['edges', '--minutes', '30'])).toBe(0);
    expect(readMapEdges).toHaveBeenCalledWith('30m', { before: undefined });
    expect(formatMapEdgesText).toHaveBeenCalledWith(result);
    expect(log).toHaveBeenCalledWith('fake-agent -> fake-worker: hello');
  });

  it('prints the existing JSON schema and returns unavailable status', async () => {
    expect(await cmdMap(['edges', '--minutes', '30', '--json'])).toBe(0);
    expect(readMapEdges).toHaveBeenCalledWith('30m', { before: undefined });
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(result);
    readMapEdges.mockReturnValue({ ...result, source: 'unavailable', edges: null });
    expect(await cmdMap(['edges', '--json', '--minutes', '30'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[1]![0])).source).toBe('unavailable');
  });

  it('preserves since durations', async () => {
    expect(await cmdMap(['edges', '--since', '10m'])).toBe(0);
    expect(readMapEdges).toHaveBeenCalledWith('10m', { before: undefined });
  });

  it.each([
    ['--minutes'], ['--minutes', '0'], ['--minutes', '-1'], ['--minutes', '1.5'],
    ['--minutes', '1e2'], ['--minutes', '9007199254740992'], ['--minutes', 'abc'],
    ['--minutes', '--json'], ['--minutes', '30', '--minutes', '10'],
    ['--minutes', '30', '--since', '10m'], ['--since', '10m', '--minutes', '30'],
  ])('rejects invalid arguments %j before reading', async (...args) => {
    expect(await cmdMap(['edges', ...args])).toBe(2);
    expect(readMapEdges).not.toHaveBeenCalled();
  });
});
