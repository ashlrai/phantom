import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDesktop } from '../src/cli/desktop.js';

afterEach(() => vi.restoreAllMocks());

describe('managed desktop install availability', () => {
  it.each([
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['darwin', 'x64'],
  ])('reports unsupported-platform on %s/%s before package custody', async (platform, arch) => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!;
    const run = (args: string[], emit: Parameters<typeof cmdDesktop>[2]) => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
      Object.defineProperty(process, 'arch', { ...archDescriptor, value: arch });
      try { return cmdDesktop(args, undefined, emit); }
      finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
        Object.defineProperty(process, 'arch', archDescriptor);
      }
    };

    const emit = vi.fn();
    expect(await run(['install', '--apply'], emit)).toBe(1);
    expect(emit).toHaveBeenLastCalledWith({
      state: 'held', reason: 'unsupported-platform', version: null,
      installationAccepted: false, authorityResumed: false, shell: [],
    });
    for (const mode of ['upgrade', 'rollback']) {
      expect(await run(['install', '--' + mode, '--apply'], emit)).toBe(1);
      expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
        schema: 'desktop-upgrade.v1', mode, state: 'held', reason: 'unsupported-platform',
        applied: false, authorityResumed: false,
        stop: expect.objectContaining({ engaged: null, drained: null }),
        daemon: expect.objectContaining({ stop: expect.objectContaining({ performed: false }) }),
      }));
    }
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('points Windows and Linux users to the browser workbench', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDesktop(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('On Windows or Linux, run phm verse'));
  });
});
