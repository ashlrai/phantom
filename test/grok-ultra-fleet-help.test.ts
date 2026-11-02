import { describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

describe('fleet Grok usage help', () => {
  it('lists Grok usage alongside the legacy status option', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleet(['--help'])).toBe(0);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('fleet grok-usage');
      expect(output).toContain('fleet status [--json] [--legacy]');
    } finally {
      log.mockRestore();
    }
  });

  it('dispatches Grok usage help to the subcommand', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cmdFleet(['grok-usage', 'record', '--help'])).toBe(0);
      expect(write.mock.calls.map(([text]) => String(text)).join('')).toContain('--remaining-points');
    } finally {
      write.mockRestore();
    }
  });
});
