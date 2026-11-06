import { describe, expect, it, vi } from 'vitest';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: () => {} }));
const mock = vi.hoisted(() => ({ observer: vi.fn() }));
vi.mock('../src/cli/fleet-apps-changes.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/cli/fleet-apps-changes.js')>();
  return { ...actual, observeFleetAppsChanges: mock.observer };
});
const actual = await vi.importActual<typeof import('../src/cli/fleet-apps-changes.js')>('../src/cli/fleet-apps-changes.js');
const name = 'phantom_fleet_apps_changes';
const stamp = '2026-11-01T00:00:00.000Z';
const snapshot = (running: boolean | null) => JSON.stringify({ v: 1, available: true, generatedAt: stamp, apps: FLEET_APPS.map(app => ({ app, running, checkedAt: stamp })) });

describe('native fleet app changes', () => {
  it('registers a closed read-only schema and rejects malformed arguments before observing', async () => {
    expect(nativeToolSafety(name)).toBe('read');
    expect(listNativeTools().find(t => t.name === name)?.inputSchema).toMatchObject({ required: ['durationMs'], additionalProperties: false });
    mock.observer.mockClear();
    for (const args of [null, [], {}, { durationMs: 0 }, { durationMs: 1.5 }, { durationMs: 10001 }, { durationMs: 1, intervalMs: 99 }, { durationMs: 1, apps: [] }, { durationMs: 1, apps: ['bad'] }, { durationMs: 1, apps: [FLEET_APPS[0], FLEET_APPS[0]] }, { durationMs: 1, root: '/tmp' }]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
    expect(mock.observer).not.toHaveBeenCalled();
  });
  it('shares selected transitions with the native call and never writes or mutates', async () => {
    let time = 0, i = 0;
    const runChild = vi.fn(async (args: string[]) => {
      expect(args).toEqual(['fleet', 'apps-status', '--json']);
      return { code: 0, stdout: snapshot([true, false, true][Math.min(i++, 2)]!) };
    });
    const deps = { runChild, now: () => time, sleep: async (ms: number) => { time += ms; } };
    mock.observer.mockImplementation((options) => actual.observeFleetAppsChanges(options, deps));
    const write = vi.spyOn(process.stdout, 'write');
    const result = await callNativeTool(name, { durationMs: 300, intervalMs: 100, apps: [FLEET_APPS[0]] });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.events.map((e: { state: string }) => e.state)).toEqual(['running', 'stopped', 'running']);
    expect(payload).toMatchObject({ v: 1, outcome: 'complete', samples: 3, transitions: 2, truncated: false });
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
  it('reports unknown evidence, caps events, and bounds pending probes', async () => {
    let time = 0, i = 0;
    const result = await actual.observeFleetAppsChanges({ durationMs: 400, intervalMs: 100, apps: [FLEET_APPS[0]!], maxEvents: 2 }, {
      now: () => time, sleep: async ms => { time += ms; }, runChild: async () => ({ code: 0, stdout: [snapshot(true), '{', snapshot(false), snapshot(true)][i++]! }),
    });
    expect(result.events.map(e => e.state)).toEqual(['running', 'unknown']);
    expect(result).toMatchObject({ transitions: 3, truncated: true });
    const controller = new AbortController();
    const pending = actual.observeFleetAppsChanges({ durationMs: 1000 }, { signal: controller.signal, runChild: async () => { controller.abort(); return new Promise(() => {}); } });
    expect((await pending).outcome).toBe('cancelled');
  });
  it('returns a generic failure', async () => {
    mock.observer.mockRejectedValueOnce(new Error('/private/path stderr'));
    const result = await callNativeTool(name, { durationMs: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'Fleet observation unavailable' });
  });
});
