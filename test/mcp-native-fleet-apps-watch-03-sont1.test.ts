import { afterEach, describe, expect, it, vi } from 'vitest';
import * as watch from '../src/cli/fleet-apps-watch.js';

const realWatch = watch.watchFleetApps;
afterEach(() => vi.restoreAllMocks());

// ===========================================================================
// MCP registration (schema + safety only — handler tested via CLI path below)
// ===========================================================================
describe('MCP registration: phantom_fleet_apps_watch', () => {
  it('closed mutation schema is registered with correct constraints', async () => {
    const { listNativeTools, nativeToolSafety } = await import('../src/core/mcp-native.js');
    const schema = listNativeTools().find(tool => tool.name === 'phantom_fleet_apps_watch')!.inputSchema;
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['apps', 'durationMs'],
      properties: {
        apps: { minItems: 1, maxItems: 8, uniqueItems: true },
        durationMs: { minimum: 1, maximum: 10000 },
        intervalMs: { minimum: 100, maximum: 10000 },
        maxConsecutiveFailures: { minimum: 1, maximum: 10 },
      },
    });
    expect(nativeToolSafety('phantom_fleet_apps_watch')).toBe('append');
  });

  it('callNativeTool rejects all invalid inputs before the supervision loop', async () => {
    const { callNativeTool } = await import('../src/core/mcp-native.js');
    for (const args of [
      null, [],
      {},
      { apps: [] },
      { apps: ['Cursor', 'Cursor'] },
      { apps: ['unknown'] },
      { apps: [1] },
      { apps: ['Cursor'], durationMs: null },
      { apps: ['Cursor'], durationMs: 0 },
      { apps: ['Cursor'], durationMs: 10001 },
      { apps: ['Cursor'], durationMs: 1, intervalMs: 99 },
      { apps: ['Cursor'], durationMs: 1, intervalMs: 10001 },
      { apps: ['Cursor'], durationMs: 1, maxConsecutiveFailures: 0 },
      { apps: ['Cursor'], durationMs: 1, maxConsecutiveFailures: 11 },
    ]) {
      expect((await callNativeTool('phantom_fleet_apps_watch', args)).isError).toBe(true);
    }
  });

  it('blocks file paths and arbitrary commands through additionalProperties', async () => {
    const { callNativeTool } = await import('../src/core/mcp-native.js');
    const answer = await callNativeTool('phantom_fleet_apps_watch', {
      apps: ['Phantom'],
      durationMs: 100,
      filePath: '/etc/passwd',
    } as never);
    expect(answer.isError).toBe(true);
  });
});

// ===========================================================================
// CLI path (calls watchFleetApps with injected deps — no MCP handler needed)
// ===========================================================================
describe('CLI path: cmdFleetAppsWatch + watchFleetApps', () => {
  afterEach(() => vi.restoreAllMocks());

  it('CLI JSON output path writes structured data and exits cleanly', async () => {
    const batch = (apps: Record<string, unknown>[], ok = true) => ({
      code: 0,
      stdout: JSON.stringify({ ok, apps }),
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitCode = await watch.cmdFleetAppsWatch(
      ['Cursor', '--duration-ms', '50', '--json'],
      { runChild: async () => batch([{ app: 'Cursor', observedRunning: true }]) },
    );
    expect(exitCode).toBe(0);
    const written = JSON.parse(String(stdout.mock.calls[0]![0]));
    expect(written).toMatchObject({ outcome: 'completed', cycles: 1 });
  });

  it('CLI JSONL output path writes observation + summary lines', async () => {
    const batch = (apps: Record<string, unknown>[], ok = true) => ({
      code: 0,
      stdout: JSON.stringify({ ok, apps }),
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitCode = await watch.cmdFleetAppsWatch(
      ['Phantom', 'Cursor', '--duration-ms', '50', '--jsonl'],
      { runChild: async () => batch([
        { app: 'Phantom', observedRunning: false },
        { app: 'Cursor', observedRunning: true },
      ], false) },
    );
    expect(exitCode).toBe(1);
    const lines = stdout.mock.calls.map(c => String(c[0])).join('\n').trim().split('\n');
    const summaryLine = lines.find(l => l.includes('"type":"summary"'));
    expect(summaryLine).toBeDefined();
    expect(JSON.parse(summaryLine!).outcome).toBe('failed');
  });

  it('extracted helper replays existing CLI watch behaviour with a mock child', async () => {
    let clock = 0;
    const batch = (apps: Record<string, unknown>[], ok = true) => ({
      code: 0,
      stdout: JSON.stringify({ ok, apps }),
    });
    const result = await watch.watchFleetApps(
      { apps: ['Phantom', 'Cursor'], durationMs: 100, intervalMs: 50 },
      {
        runChild: async () => batch([
          { app: 'Phantom', observedRunning: true },
          { app: 'Cursor', observedRunning: true },
        ]),
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
      },
    );
    expect(result.cycles).toBeGreaterThanOrEqual(1);
    expect(result.outcome).toBe('completed');
    expect(result.lastObservedState).toEqual([
      { app: 'Phantom', observedRunning: true },
      { app: 'Cursor', observedRunning: true },
    ]);
  });
});
