import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDaemon } from '../src/cli/daemon.js';
import { daemonStatePath, daemonStateRecoveryMarkerPath } from '../src/core/daemon/state.js';

const originalHome = process.env.HOME;
let home: string;
const tick = '2026-11-05T12:00:00.000Z';
const state = { running: false, pid: null, startedAt: null, lastTickAt: tick,
  todayDate: '2026-11-05', todaySpentUsd: 0, itemsProcessed: 0, ticks: [] };

async function run(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await cmdDaemon(args);
    return { code, output: log.mock.calls.map((row) => row.join(' ')).join('\n') };
  } finally { log.mockRestore(); error.mockRestore(); }
}
function writeState(value: string) {
  const path = daemonStatePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'daemon-fast-')); process.env.HOME = home; });
afterEach(() => { process.env.HOME = originalHome; rmSync(home, { recursive: true, force: true }); });

describe('daemon status fast observation', () => {
  it('reads valid state through cmdDaemon, reflects changes and does not probe normal status', async () => {
    writeState(JSON.stringify(state));
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(await run(['status', '--fast', '--json'])).toEqual({ code: 0, output: JSON.stringify({ lastTickAt: tick }) });
      expect(kill).not.toHaveBeenCalled();
      const next = '2026-11-06T12:00:00.000Z';
      writeState(JSON.stringify({ ...state, lastTickAt: next }));
      expect(JSON.parse((await run(['status', '--fast', '--json'])).output)).toEqual({ lastTickAt: next });
    } finally { kill.mockRestore(); }
  });
  it('returns unknown for missing, corrupt, oversized and recovery-marked state', async () => {
    const observe = async () => JSON.parse((await run(['status', '--fast', '--json'])).output);
    expect(await observe()).toEqual({ lastTickAt: null });
    writeState('{');
    expect(await observe()).toEqual({ lastTickAt: null });
    writeState(' '.repeat(1024 * 1024 + 1));
    expect(await observe()).toEqual({ lastTickAt: null });
    writeState(JSON.stringify(state));
    const marker = daemonStateRecoveryMarkerPath();
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, '{}', { mode: 0o600 });
    expect(await observe()).toEqual({ lastTickAt: null });
  });
  it('rejects invalid flags and leaves regular status available', async () => {
    expect((await run(['status', '--fast', '--bogus'])).code).not.toBe(0);
    expect((await run(['health', '--fast'])).code).not.toBe(0);
    writeState(JSON.stringify(state));
    expect((await run(['status', '--json'])).code).toBe(0);
  });
});
