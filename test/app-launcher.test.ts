import { describe, expect, it, vi } from 'vitest';
import { createMacOsAppLauncher, defaultHostAppLauncher } from '../src/core/verse/app-launcher.js';

describe('macOS AppLauncher', () => {
  it('runs /usr/bin/open -b for open and activate', async () => {
    const exec = vi.fn((_file: string, _args: readonly string[], _opts: { timeout: number }, cb: (error: Error | null) => void) => {
      cb(null);
    });
    const launcher = createMacOsAppLauncher(exec);
    expect(await launcher.open('com.apple.Notes')).toEqual({ ok: true });
    expect(await launcher.activate('com.apple.Notes')).toEqual({ ok: true });
    expect(exec.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['/usr/bin/open', ['-b', 'com.apple.Notes']],
      ['/usr/bin/open', ['-b', 'com.apple.Notes']],
    ]);
  });

  it('refuses non-bundle ids before spawning and surfaces exec errors', async () => {
    const exec = vi.fn((_file: string, _args: readonly string[], _opts: { timeout: number }, cb: (error: Error | null) => void) => {
      cb(new Error('spawn open ENOENT'));
    });
    const launcher = createMacOsAppLauncher(exec);
    expect(await launcher.open('Notes')).toEqual({ ok: false, error: 'bundle id is not a LaunchServices bundle identifier.' });
    expect(exec).not.toHaveBeenCalled();
    expect(await launcher.open('com.apple.Notes')).toEqual({ ok: false, error: 'spawn open ENOENT' });
  });

  it('defaultHostAppLauncher is darwin-only', () => {
    const exec = vi.fn();
    expect(defaultHostAppLauncher('linux', exec)).toBeUndefined();
    expect(defaultHostAppLauncher('darwin', exec)).toBeDefined();
  });
});
