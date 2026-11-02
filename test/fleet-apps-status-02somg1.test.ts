import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppsStatus, type FleetAppsStatusView, type FleetAppsStatusDeps } from '../src/cli/fleet-apps-status.js';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';

const SCRIPT = '/checkout/scripts/mac-bridge/app_control.py';
const LOCATE = () => SCRIPT;

function okStatus(app: string, running: boolean) {
  return JSON.stringify({ action: 'status', app, ok: true, code: 'ok', running });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('fleet apps-status CLI', () => {
  it('--help prints usage and exits 0 without executing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn();
    expect(await cmdFleetAppsStatus(['--help'], { exec, locateScript: LOCATE })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet apps-status'));
    expect(exec).not.toHaveBeenCalled();
  });

  it('-h is an alias for --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn();
    expect(await cmdFleetAppsStatus(['-h'], { exec, locateScript: LOCATE })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses unknown options with usage on stderr, exit 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn();
    expect(await cmdFleetAppsStatus(['--bogus'], { exec, locateScript: LOCATE })).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('unknown option'));
  });

  it('refuses duplicate flags with usage on stderr, exit 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn();
    expect(await cmdFleetAppsStatus(['--json', '--json'], { exec, locateScript: LOCATE })).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('duplicate option'));
  });

  it('refuses --root without a value, exit 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn();
    expect(await cmdFleetAppsStatus(['--root'], { exec, locateScript: LOCATE })).toBe(2);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects positional arguments as unknown, exit 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn();
    expect(await cmdFleetAppsStatus(['phantom'], { exec, locateScript: LOCATE })).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('unexpected argument'));
  });

  it('reports missing bridge as unavailable with nonzero exit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn();
    const code = await cmdFleetAppsStatus([], { exec, locateScript: () => null });
    expect(code).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('unavailable');
  });

  it('returns all apps with running=null when bridge is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn();
    const code = await cmdFleetAppsStatus([], { exec, locateScript: () => null });
    expect(code).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('unknown');
  });

  it('prints only allowlisted fields in --json, never raw script output or stderr', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ running: true, code: 'ok', rawSecret: 'hidden' }),
      stderr: 'error trace never shown',
    }));
    await cmdFleetAppsStatus(['--json'], { exec, locateScript: LOCATE });
    const jsonStr = (stdout.mock.calls[0] as [string])[0];
    const parsed: FleetAppsStatusView = JSON.parse(jsonStr);
    expect(parsed.v).toBe(1);
    expect(typeof parsed.generatedAt).toBe('string');
    expect(parsed.available).toBe(true);
    expect(parsed.apps.length).toBe(FLEET_APPS.length);
    expect(parsed.degraded).toBe(false);
    expect(jsonStr).not.toContain('hidden');
    expect(jsonStr).not.toContain('error trace');
    for (const app of parsed.apps) {
      expect(Object.keys(app)).toEqual(expect.arrayContaining(['app', 'running', 'checkedAt']));
    }
  });

  it('returns all eight apps with mixed running values and explicit degraded', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let callIndex = 0;
    const responses = [
      JSON.stringify({ running: true, code: 'ok' }),
      JSON.stringify({ running: false, code: 'not_running' }),
      JSON.stringify({ running: true, code: 'ok' }),
      'malformed json',
      JSON.stringify({ running: true, code: 'ok' }),
      JSON.stringify({ running: false, code: 'not_running' }),
      JSON.stringify({ running: true, code: 'ok' }),
      JSON.stringify({ running: null, code: 'unknown' }),
    ];
    const exec = vi.fn(async () => {
      const resp = responses[callIndex++ % responses.length];
      return { stdout: resp, stderr: 'private log' };
    });
    const code = await cmdFleetAppsStatus([], { exec, locateScript: LOCATE });
    expect(code).toBe(1);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('degraded');
  });

  it('handles malformed JSON output gracefully, stays unknown', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn(async () => ({ stdout: 'not json at all', stderr: 'error detail' }));
    const code = await cmdFleetAppsStatus([], { exec, locateScript: LOCATE });
    expect(code).toBe(1);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('unknown');
    expect(output).not.toContain('not json');
  });

  it('handles script crash/timeout, stays unknown per app', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), { code: 1, stdout: JSON.stringify({ running: false }), stderr: 'stderr never echoed' });
    });
    const code = await cmdFleetAppsStatus([], { exec, locateScript: LOCATE });
    expect(code).toBe(1);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('unknown');
  });

  it('limits concurrent probes to maxConcurrent (default 2)', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const exec = vi.fn(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise(r => setTimeout(r, 50));
      concurrentCount--;
      return { stdout: okStatus('test', true), stderr: '' };
    });
    await cmdFleetAppsStatus([], { exec, locateScript: LOCATE, maxConcurrent: 2 });
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('admits a short deadline: probes fewer than all eight', async () => {
    let time = 100_000;
    const exec = vi.fn(async () => {
      time += 30;
      await new Promise(r => setTimeout(r, 30));
      return { stdout: okStatus('test', true), stderr: '' };
    });
    const code = await cmdFleetAppsStatus([], {
      exec,
      locateScript: LOCATE,
      now: () => time,
      totalDeadline: 55,
      maxConcurrent: 2,
    });
    // 2 concurrent × 30ms = 60ms per round, 55ms total → only ~2 apps probed
    const executed = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(executed).toBeLessThan(FLEET_APPS.length);
    expect(code).toBe(1);
  });

  it('prints human-readable output without --json showing available', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn(async () => ({ stdout: okStatus('Phantom', true), stderr: '' }));
    await cmdFleetAppsStatus([], { exec, locateScript: LOCATE });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('available');
  });

  it('prints "unavailable" when script is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdFleetAppsStatus([], { locateScript: () => null });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('unavailable');
  });

  it('returns view shape matching FleetAppsStatusView contract', async () => {
    const exec = vi.fn(async () => ({ stdout: okStatus('Phantom', true), stderr: '' }));
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await cmdFleetAppsStatus(['--json'], {
      exec,
      locateScript: LOCATE,
    });
    const parsed: FleetAppsStatusView = JSON.parse((stdout.mock.calls[0] as [string])[0]);
    expect(parsed).toHaveProperty('v', 1);
    expect(typeof parsed.generatedAt).toBe('string');
    expect(typeof parsed.available).toBe('boolean');
    expect(Array.isArray(parsed.apps)).toBe(true);
    expect(parsed.apps.length).toBe(FLEET_APPS.length);
    for (const app of parsed.apps) {
      expect(app).toHaveProperty('app');
      expect(app).toHaveProperty('running');
      expect(app).toHaveProperty('checkedAt');
    }
  });
});
