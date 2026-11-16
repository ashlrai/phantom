import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import * as watch from '../src/cli/fleet-apps-watch.js';

const name = 'phantom_fleet_apps_watch';
const payload = (value: Awaited<ReturnType<typeof callNativeTool>>) => JSON.parse(value.content[0]!.text);

afterEach(() => vi.restoreAllMocks());
registerFleetNativeTools();

// Recut of PR #3162 (RQ-PHX-MCPAPPSWATCH03SONT1) onto current master: the
// phantom_fleet_apps_watch MCP tool exposes the apps-watch supervision loop as
// structured data. These cases drive the real callNativeTool entry point and
// stub only the innermost leaf (watchFleetApps), like the sibling
// mcp-native-fleet-apps-* suites.
describe('recut core o1 s132: phantom_fleet_apps_watch via callNativeTool', () => {
  it('is registered with a closed append schema', () => {
    const tool = listNativeTools().find(candidate => candidate.name === name);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['apps', 'durationMs'],
    });
    expect(nativeToolSafety(name)).toBe('append');
  });

  it('routes valid args through validation to the supervision helper and returns its structured result', async () => {
    const result: watch.FleetAppsWatchResult = {
      apps: ['Cursor'],
      outcome: 'completed',
      cycles: 2,
      recoveries: 1,
      consecutiveFailures: 0,
      totalFailedCycles: 1,
      lastObservedState: [{ app: 'Cursor', observedRunning: true }],
      lastDiagnostics: [{ app: 'Cursor', outcome: 'launched', launched: true }],
    };
    const spy = vi.spyOn(watch, 'watchFleetApps').mockResolvedValue(result);
    const answer = await callNativeTool(name, { apps: ['Cursor'], durationMs: 500, intervalMs: 250, maxConsecutiveFailures: 3 });
    expect(answer.isError).toBeUndefined();
    expect(payload(answer)).toEqual(result);
    expect(spy).toHaveBeenCalledWith({ apps: ['Cursor'], durationMs: 500, intervalMs: 250, maxConsecutiveFailures: 3 });
  });

  it('fills helper defaults for optional knobs', async () => {
    const spy = vi.spyOn(watch, 'watchFleetApps').mockResolvedValue({
      apps: ['Phantom'], outcome: 'failed', cycles: 1, recoveries: 0,
      consecutiveFailures: 1, totalFailedCycles: 1, lastObservedState: null, lastDiagnostics: null,
    });
    await callNativeTool(name, { apps: ['Phantom'], durationMs: 100 });
    expect(spy).toHaveBeenCalledWith({ apps: ['Phantom'], durationMs: 100, intervalMs: 1000, maxConsecutiveFailures: 1 });
  });

  it('rejects invalid args before the helper and never mutates', async () => {
    const spy = vi.spyOn(watch, 'watchFleetApps');
    for (const args of [
      { apps: ['Cursor'] },
      { apps: ['Cursor'], durationMs: 10001 },
      { apps: ['Cursor'], durationMs: 10, filePath: '/tmp/x' },
      { apps: ['Cursor', 'Cursor'], durationMs: 10 },
      { apps: ['NotAnApp'], durationMs: 10 },
    ]) {
      expect((await callNativeTool(name, args as never)).isError).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a helper throw to the fleet app watch unavailable error without leaking internals', async () => {
    vi.spyOn(watch, 'watchFleetApps').mockRejectedValue(new Error('/private/child/path blew up'));
    const answer = await callNativeTool(name, { apps: ['Cursor'], durationMs: 100 });
    expect(answer.isError).toBe(true);
    expect(payload(answer)).toEqual({ error: 'Fleet app watch unavailable' });
    expect(JSON.stringify(answer)).not.toContain('/private/child/path');
  });
});
