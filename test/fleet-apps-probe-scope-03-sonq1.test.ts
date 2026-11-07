import { describe, expect, it, vi } from 'vitest';
import { cmdFleetAppsStatus } from '../src/cli/fleet-apps-status.js';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';

describe('fleet apps-status probe selection', () => {
  it('probes only selected apps in canonical order and reports their health', async () => {
    const exec = vi.fn(async (_file: string, _argv: readonly string[]) => ({ stdout: JSON.stringify({ ok: true, running: true }), stderr: '' }));
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    try {
      const code = await cmdFleetAppsStatus(['--json', '--app', FLEET_APPS[2]!, '--app', FLEET_APPS[0]!, '--app', FLEET_APPS[2]!], { locateScript: () => '/fake/script', exec });
      expect(code).toBe(0);
      expect(exec.mock.calls.map(call => call[1][3])).toEqual([FLEET_APPS[0], FLEET_APPS[2]]);
      expect(JSON.parse(output).apps.map((row: { app: string }) => row.app)).toEqual([FLEET_APPS[0], FLEET_APPS[2]]);
    } finally { write.mockRestore(); }
  });
  it('rejects unknown apps before probing', async () => {
    const exec = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(await cmdFleetAppsStatus(['--app', 'unknown'], { exec })).toBe(2); expect(exec).not.toHaveBeenCalled(); }
    finally { error.mockRestore(); }
  });
});
