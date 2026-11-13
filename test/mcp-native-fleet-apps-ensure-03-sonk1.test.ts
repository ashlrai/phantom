import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as recovery from '../src/cli/fleet-apps-ensure.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

const name = 'phantom_fleet_apps_ensure';
const realEnsure = recovery.ensureFleetApps;
const result = (app: string, outcome: string, running = false, launched = false) => ({
  code: running ? 0 : 1, stdout: JSON.stringify({ app, outcome, running, launched }),
});
const payload = (value: Awaited<ReturnType<typeof callNativeTool>>) => JSON.parse(value.content[0]!.text);
afterEach(() => vi.restoreAllMocks());

describe('native fleet apps ensure', () => {
  it('advertises a closed mutation schema and rejects invalid input before recovery', async () => {
    const schema = listNativeTools().find(tool => tool.name === name)!.inputSchema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['apps'], properties: { apps: { minItems: 1, maxItems: 8, uniqueItems: true }, timeoutMs: { minimum: 1, maximum: 30000 } } });
    expect(nativeToolSafety(name)).toBe('append');
    const spy = vi.spyOn(recovery, 'ensureFleetApps');
    for (const args of [null, [], {}, { apps: [] }, { apps: ['Cursor', 'Cursor'] }, { apps: ['unknown'] }, { apps: [1] }, { apps: ['Cursor'], root: '/fake' }, { apps: ['Cursor'], timeoutMs: null }, { apps: ['Cursor'], timeoutMs: 0 }, { apps: ['Cursor'], timeoutMs: 30001 }, { apps: ['Cursor'], timeoutMs: 1.5 }]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns running, launched, refusal and unknown outcomes without stdout', async () => {
    const runner: recovery.AppsEnsureChildRunner = async args => {
      const app = args[2]!;
      if (app === 'Cursor') return result(app, 'running', true);
      if (app === 'Claude') return result(app, 'launched', true, true);
      if (app === 'Codex') return result(app, 'launch-failed');
      return { code: 1, stdout: 'private child stderr /private/path' };
    };
    vi.spyOn(recovery, 'ensureFleetApps').mockImplementation(options => realEnsure(options, { runChild: runner }));
    const stdout = vi.spyOn(process.stdout, 'write');
    const answer = await callNativeTool(name, { apps: ['Cursor', 'Claude', 'Codex', 'Safari'] });
    expect(payload(answer)).toMatchObject({ ok: false, endedBy: 'complete', apps: [
      { outcome: 'running', observedRunning: true, launched: false },
      { outcome: 'launched', observedRunning: true, launched: true },
      { outcome: 'launch-failed', observedRunning: false },
      { outcome: 'unavailable', observedRunning: false },
    ] });
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.stringify(answer)).not.toContain('/private/path');
  });

  it('bounds the group and leaves remaining rows unattempted', async () => {
    const runner = vi.fn<recovery.AppsEnsureChildRunner>(() => new Promise(() => {}));
    vi.spyOn(recovery, 'ensureFleetApps').mockImplementation(options => realEnsure(options, { runChild: runner }));
    const answer = payload(await callNativeTool(name, { apps: ['Cursor', 'Claude'], timeoutMs: 10 }));
    expect(answer).toMatchObject({ ok: false, endedBy: 'deadline', apps: [{ outcome: 'timeout' }, { outcome: 'unattempted', reason: 'deadline' }] });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('hides unexpected dependency errors', async () => {
    vi.spyOn(recovery, 'ensureFleetApps').mockRejectedValue(new Error('/private/path stderr'));
    const answer = await callNativeTool(name, { apps: ['Cursor'] });
    expect(answer.isError).toBe(true);
    expect(payload(answer)).toEqual({ error: 'Fleet recovery unavailable' });
  });

  it('preserves CLI JSON and exit behavior', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await recovery.cmdFleetAppsEnsure(['Cursor', '--json'], { runChild: async () => result('Cursor', 'running', true) })).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({ ok: true, apps: [{ app: 'Cursor', observedRunning: true }] });
  });
});

registerFleetNativeTools();
