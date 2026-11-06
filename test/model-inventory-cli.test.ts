import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/resources/model-inventory.js', () => ({ runModelInventory: vi.fn() }));
import { runModelInventory } from '../src/core/resources/model-inventory.js';
import { cmdModels } from '../src/cli/models.js';
afterEach(() => vi.restoreAllMocks());
describe('models inventory CLI', () => {
  it('dispatches inventory JSON without invoking model management', async () => {
    const result = { schemaVersion: 1 as const, measuredAt: new Date(0).toISOString(), promptTokens: 512 as const,
      repetitions: 3 as const, models: [], unavailableEngines: [] };
    vi.mocked(runModelInventory).mockResolvedValue(result);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdModels(['inventory', '--json'])).toBe(0);
    expect(output).toHaveBeenCalledWith(JSON.stringify(result, null, 2) + '\n');
  });
  it('returns failure for a partial inventory', async () => {
    vi.mocked(runModelInventory).mockResolvedValue({ schemaVersion: 1, measuredAt: new Date(0).toISOString(),
      promptTokens: 512, repetitions: 3, models: [], unavailableEngines: ['omlx'] });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdModels(['inventory', '--json'])).toBe(1);
  });
  it('keeps raw exception details out of diagnostics', async () => {
    vi.mocked(runModelInventory).mockRejectedValue(new Error('TEST-private-detail'));
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdModels(['inventory'])).toBe(1);
    expect(output.mock.calls.join('')).not.toContain('TEST-private-detail');
  });
  it('shows help without starting inventory', async () => {
    const runner = vi.mocked(runModelInventory); runner.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdModels(['inventory', '--help'])).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });
  it.each([['inventory', '--yes'], ['inventory', 'extra']])('refuses unsupported args %j', async (...args) => {
    const runner = vi.mocked(runModelInventory); runner.mockClear(); vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdModels(args)).toBe(2); expect(runner).not.toHaveBeenCalled();
  });
});
