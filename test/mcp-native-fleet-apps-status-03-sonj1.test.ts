import { afterEach, describe, expect, it, vi } from 'vitest';
import * as inventory from '../src/cli/fleet-apps-status.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';

const name = 'phantom_fleet_apps_status';
const timestamp = '2026-11-01T18:09:00.000Z';
const view = (available: boolean, degraded?: boolean): inventory.FleetAppsStatusView => ({
  v: 1, generatedAt: timestamp, available, ...(degraded === undefined ? {} : { degraded }),
  apps: FLEET_APPS.map((app, index) => ({ app, running: available ? index === 0 ? false : index === 1 && degraded ? null : true : null, checkedAt: timestamp })),
});

afterEach(() => vi.restoreAllMocks());

describe('native fleet apps status', () => {
  it('advertises a closed read-only tool and rejects arguments before reading', async () => {
    expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(nativeToolSafety(name)).toBe('read');
    const reader = vi.spyOn(inventory, 'readFleetAppsStatus');
    for (const args of [{ root: '/fake' }, { unexpected: true }, null, []]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([view(true, false), view(true, true), view(false)])('round-trips inventory: available=$available degraded=$degraded', async expected => {
    vi.spyOn(inventory, 'readFleetAppsStatus').mockResolvedValue(expected);
    const result = await callNativeTool(name, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual(expected);
    expect(expected.apps).toHaveLength(8);
  });

  it('returns a generic bounded error if the reader throws', async () => {
    vi.spyOn(inventory, 'readFleetAppsStatus').mockRejectedValue(new Error('/private/path raw child stderr'));
    const result = await callNativeTool(name, {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'Fleet observation unavailable' });
  });

  it('reads fake evidence without stdout, preserving stopped and unknown rows', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const exec = vi.fn(async (_file, args: string[]) => ({
      stdout: args[3] === FLEET_APPS[1] ? 'invalid' : JSON.stringify({ ok: true, running: args[3] !== FLEET_APPS[0] }),
      stderr: 'private child detail',
    }));
    const actual = await inventory.readFleetAppsStatus({ locateScript: () => '/fake/bridge.py', runsDir: '/fake/runs', exec });
    expect(actual).toMatchObject({ v: 1, available: true, degraded: true });
    expect(actual.apps.map(row => row.app)).toEqual([...FLEET_APPS]);
    expect(actual.apps[0]!.running).toBe(false);
    expect(actual.apps[1]!.running).toBeNull();
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.stringify(actual)).not.toContain('private child detail');
    const missing = await inventory.readFleetAppsStatus({ locateScript: () => null, exec });
    expect(missing.available).toBe(false);
    expect(missing.apps).toHaveLength(8);
    expect(missing.apps.every(row => row.running === null)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(8);
  });
});
