import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPaused, loadPauseState, setPause } from '../src/core/comms/pause.js';

describe('comms pause fails closed', () => {
  const originalHome = process.env.HOME;
  let home: string;
  let path: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'comms-pause-'));
    process.env.HOME = home;
    path = join(home, '.ashlr', 'comms', 'pause.json');
    mkdirSync(join(home, '.ashlr', 'comms'), { recursive: true });
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function expectState(paused: boolean, since?: number): void {
    expect(loadPauseState()).toEqual(since === undefined ? { paused } : { paused, since });
    expect(isPaused()).toBe(paused);
  }

  it('treats an absent path as unpaused', () => { expectState(false); });
  it('reads a valid unpaused state', () => {
    writeFileSync(path, '{"paused":false,"since":123}');
    expectState(false);
  });
  it('reads a valid paused state and its numeric timestamp', () => {
    writeFileSync(path, '{"paused":true,"since":123}');
    expectState(true, 123);
  });
  it('ignores a non-numeric timestamp', () => {
    writeFileSync(path, '{"paused":true,"since":"123"}');
    expectState(true);
  });
  it('pauses for a symlink to an unpaused file', () => {
    const target = join(home, 'target');
    writeFileSync(target, '{"paused":false}');
    symlinkSync(target, path);
    expectState(true);
    setPause(false);
    expectState(false);
  });
  it('pauses for a dangling symlink', () => {
    symlinkSync(join(home, 'missing'), path);
    expectState(true);
  });
  it('pauses for a directory', () => {
    mkdirSync(path);
    expectState(true);
  });
  it('pauses for a file larger than 64 KiB', () => {
    writeFileSync(path, '{"paused":false}' + ' '.repeat(64 * 1024));
    expectState(true);
  });
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'pauses for an unreadable file (skipped as root because root can read mode 000)', () => {
      writeFileSync(path, '{"paused":false}');
      chmodSync(path, 0o000);
      expectState(true);
    },
  );
  it('pauses for invalid JSON', () => {
    writeFileSync(path, '{');
    expectState(true);
  });
  it('pauses for a JSON array', () => {
    writeFileSync(path, '[]');
    expectState(true);
  });
  it('pauses when paused is not a boolean', () => {
    writeFileSync(path, '{"paused":"false"}');
    expectState(true);
  });
});
