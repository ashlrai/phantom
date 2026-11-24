import { describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { cmdFleetGhosts } from '../src/cli/fleet-ghosts.js';

describe('fleet ghosts discovery', () => {
  it('resolves and loads the existing command through the production registry', async () => {
    const resolved = resolveFleetSubcommand('ghosts');
    expect(resolved).toEqual({ module: './fleet-ghosts.js', exportName: 'cmdFleetGhosts' });
    const handler = (await FLEET_SUBCOMMAND_LOADERS.ghosts())[resolved!.exportName];
    expect(handler).toBe(cmdFleetGhosts);
    const read = vi.fn().mockRejectedValue(new Error('must not inspect host'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await (handler as typeof cmdFleetGhosts)(['--help'], read)).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Read only'));
      expect(read).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('rejects --apply before inspecting host state', async () => {
    const read = vi.fn().mockRejectedValue(new Error('must not inspect host'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdFleetGhosts(['--apply'], read)).toBe(2);
      expect(read).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });
});
