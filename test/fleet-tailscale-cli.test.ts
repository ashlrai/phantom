import { describe, expect, it, vi } from 'vitest';
import { execTailscaleAware, tailscaleCliCandidates } from '../src/core/fleet/runtime-identity.js';

const HOME = '/Users/fakeuser';
const APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const USER_APP_BIN = '/Users/fakeuser/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function enoent(file: string): NodeJS.ErrnoException {
  const error = new Error(`spawnSync ${file} ENOENT`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

/** A spawn that fails ENOENT everywhere except the files in `works`. */
function spawnExcept(works: ReadonlySet<string>, output = '{"ok":true}') {
  return vi.fn((file: string, _args: readonly string[]) => {
    if (works.has(file)) return output;
    throw enoent(file);
  });
}

describe('tailscaleCliCandidates', () => {
  it('lists only absolute install locations, app bundle first', () => {
    const candidates = tailscaleCliCandidates(HOME);
    expect(candidates[0]).toBe(APP_BIN);
    expect(candidates).toContain(USER_APP_BIN);
    expect(candidates).toContain('/opt/homebrew/bin/tailscale');
    expect(candidates.every(path => path.startsWith('/'))).toBe(true);
  });

  it('omits home-derived paths when home is not absolute', () => {
    const candidates = tailscaleCliCandidates('relative-home');
    expect(candidates.some(path => path.includes('fakeuser'))).toBe(false);
    expect(candidates.every(path => path.startsWith('/'))).toBe(true);
  });
});

describe('execTailscaleAware', () => {
  it('uses PATH tailscale when it spawns, with no fallback', () => {
    const spawn = spawnExcept(new Set(['tailscale']));
    expect(execTailscaleAware('tailscale', ['status', '--json'], spawn, HOME)).toBe('{"ok":true}');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('tailscale', ['status', '--json']);
  });

  it('falls back to the macOS app bundle when tailscale is not on PATH', () => {
    const spawn = spawnExcept(new Set([APP_BIN]));
    expect(execTailscaleAware('tailscale', ['status', '--json'], spawn, HOME)).toBe('{"ok":true}');
    expect(spawn.mock.calls.map(call => call[0])).toEqual(['tailscale', APP_BIN]);
  });

  it('reaches the per-user app install and the fixed bin dirs', () => {
    const spawn = spawnExcept(new Set([USER_APP_BIN]));
    execTailscaleAware('tailscale', ['status', '--json'], spawn, HOME);
    expect(spawn.mock.calls.map(call => call[0])).toContain(USER_APP_BIN);

    const brew = spawnExcept(new Set(['/opt/homebrew/bin/tailscale']));
    execTailscaleAware('tailscale', ['status', '--json'], brew, HOME);
    expect(brew.mock.calls.map(call => call[0])).toContain('/opt/homebrew/bin/tailscale');
  });

  it('rethrows the last ENOENT when no candidate exists, keeping the unavailable contract', () => {
    const spawn = spawnExcept(new Set());
    expect(() => execTailscaleAware('tailscale', ['status', '--json'], spawn, HOME)).toThrowError(/ENOENT/);
    expect(spawn.mock.calls[0]![0]).toBe('tailscale');
    expect(spawn.mock.calls.length).toBe(1 + tailscaleCliCandidates(HOME).length);
  });

  it('does not fall back when a found binary runs and fails', () => {
    const failure = new Error('Command failed: tailscale status --json') as NodeJS.ErrnoException;
    failure.code = 1;
    const spawn = vi.fn((file: string, _args: readonly string[]) => {
      if (file === 'tailscale') throw failure;
      return '{}';
    });
    expect(() => execTailscaleAware('tailscale', ['status', '--json'], spawn, HOME)).toThrow(failure);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('passes any other command straight through with no candidate walk', () => {
    const spawn = spawnExcept(new Set(['git']));
    expect(execTailscaleAware('git', ['--version'], spawn, HOME)).toBe('{"ok":true}');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('git', ['--version']);
  });
});
