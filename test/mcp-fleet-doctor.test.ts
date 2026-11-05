import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { runFleetDoctor } from '../src/cli/fleet-doctor.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => true }));
vi.mock('../src/cli/fleet-doctor.js', () => ({ runFleetDoctor: vi.fn() }));

const report = {
  v: 1 as const,
  generatedAt: '2026-11-03T00:00:00.000Z',
  level: 'warn' as const,
  checks: [
    { name: 'leader', level: 'ok' as const, reason: 'leader lease held' },
    { name: 'stuck-prs', level: 'warn' as const, reason: '2 PRs stuck' },
  ],
};

beforeEach(() => {
  vi.mocked(runFleetDoctor).mockReset();
  vi.mocked(runFleetDoctor).mockResolvedValue(report);
});

describe('phantom_fleet_doctor MCP tool', () => {
  it('is listed as read-only with an empty closed schema', () => {
    expect(listNativeTools().find(t => t.name === 'phantom_fleet_doctor')?.inputSchema).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
    });
    expect(nativeToolSafety('phantom_fleet_doctor')).toBe('read');
  });

  it('returns the doctor report unchanged', async () => {
    const result = await callNativeTool('phantom_fleet_doctor', {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(report);
  });

  it('rejects unexpected arguments without running the doctor', async () => {
    const result = await callNativeTool('phantom_fleet_doctor', { fix: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'Fleet observation tools accept no arguments' });
    expect(runFleetDoctor).not.toHaveBeenCalled();
  });

  it('returns a generic error with no stack or path when the doctor rejects', async () => {
    vi.mocked(runFleetDoctor).mockRejectedValue(new Error('boom at /Users/someone/.ashlr-runs/x\n    at stack'));
    const result = await callNativeTool('phantom_fleet_doctor', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'Fleet observation unavailable' });
    expect(result.content[0].text).not.toMatch(/Users|ashlr-runs|stack/);
  });
});
