import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppsStatus, type FleetAppsStatusView } from '../src/cli/fleet-apps-status.js';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExec } from '../src/cli/fleet-app.js';

vi.mock('../src/cli/fleet-app.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/cli/fleet-app.js')>(),
  findAppControlScript: vi.fn(),
  findInstalledAppControlScript: vi.fn(),
}));

const script = '/fake/app_control.py';
const locateScript = () => script;
const response = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: 'private stderr' });
const output = () => vi.spyOn(process.stdout, 'write').mockReturnValue(true);
const view = (spy: ReturnType<typeof output>): FleetAppsStatusView => JSON.parse(spy.mock.calls[0]![0] as string);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('bounded fleet apps inventory', () => {
  it('treats unsuccessful, malformed and rejected observations as unknown', async () => {
    const stdout = output();
    const exec = vi.fn().mockResolvedValueOnce(response({ ok: false, running: true, secret: 'private output' }))
      .mockResolvedValueOnce(response([ { ok: true, running: true } ]))
      .mockRejectedValueOnce(new Error('private error'))
      .mockResolvedValue(response({ ok: true, running: false }));
    expect(await cmdFleetAppsStatus(['--json'], { exec, locateScript })).toBe(1);
    expect(view(stdout).apps.map(row => row.running)).toEqual([null, null, null, false, false, false, false, false]);
    expect(stdout.mock.calls[0]![0]).not.toContain('private');
    expect(stdout.mock.calls[0]![0]).not.toContain(script);
  });

  it('uses one wall budget for hanging probes and ignores late settlements', async () => {
    vi.useFakeTimers();
    const stdout = output();
    let rejectLate!: (error: Error) => void;
    let resolveLate!: (result: { stdout: string; stderr: string }) => void;
    const exec = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLate = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }));
    const pending = cmdFleetAppsStatus(['--json'], { exec, locateScript, now: () => 12345, totalDeadline: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toBe(1);
    const captured = stdout.mock.calls[0]![0];
    expect(exec).toHaveBeenCalledTimes(2);
    expect(view(stdout).apps).toHaveLength(8);
    expect(view(stdout).apps.every(row => row.running === null)).toBe(true);
    rejectLate(new Error('late private error'));
    resolveLate(response({ ok: true, running: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls[0]![0]).toBe(captured);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns success for a mixed running and stopped inventory', async () => {
    const stdout = output();
    let index = 0;
    const exec = vi.fn(async () => response({ ok: true, running: index++ % 2 === 0 }));
    expect(await cmdFleetAppsStatus(['--json'], { exec, locateScript })).toBe(0);
    expect(view(stdout).apps.map(row => row.running)).toEqual([true, false, true, false, true, false, true, false]);
    expect(view(stdout).degraded).toBe(false);
  });

  it('uses the final explicit root for installed discovery and probing', async () => {
    output();
    vi.mocked(findAppControlScript).mockReturnValue(null);
    vi.mocked(findInstalledAppControlScript).mockReturnValue(script);
    const exec = vi.fn<FleetAppExec>(async () => response({ ok: true, running: false }));
    expect(await cmdFleetAppsStatus(['--root', '/fake/explicit', '--json'], { exec, runsDir: '/fake/initial' })).toBe(0);
    expect(findInstalledAppControlScript).toHaveBeenCalledWith('/fake/explicit');
    expect(exec.mock.calls[0]![1]).toEqual(['-I', script, 'status', expect.any(String), '--output-dir', '/fake/explicit']);
  });

  it('rejects invalid arguments before discovery or execution', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn();
    const locate = vi.fn();
    expect(await cmdFleetAppsStatus(['--root'], { exec, locateScript: locate })).toBe(2);
    expect(locate).not.toHaveBeenCalled();
    expect(findAppControlScript).not.toHaveBeenCalled();
    expect(findInstalledAppControlScript).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
