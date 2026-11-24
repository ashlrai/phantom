/**
 * launchd-crashloop gates. A disable needs a fresh climbing runs delta,
 * and an admitted resident service is never disabled.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../src/core/autofix/host.js';
import { fixLaunchdCrashloop, type FixContext } from '../src/core/autofix/launchd.js';
import type { LaunchdJob, RunsSample } from '../src/core/autofix/types.js';

const NOW = Date.parse('2026-11-16T18:00:00.000Z');

function sample(minsAgo: number, runs: number, exit = 1): RunsSample {
  return { atMs: NOW - minsAgo * 60_000, runs, lastExitCode: exit, pid: 100 };
}

function job(overrides: Partial<LaunchdJob> = {}): LaunchdJob {
  return {
    label: 'ai.ashlr.example',
    domain: 'gui',
    disabled: false,
    samples: [sample(20, 2), sample(2, 22)],
    logTail: 'loop exit 9',
    plistMtimeMs: NOW - 60 * 60_000,
    rollbackMtimeMs: null,
    ...overrides,
  };
}

function hostWith(print: string, status = 'Resident admission: blocked\nService: ai.ashlr.daemon not-loaded\n') {
  const host = createMemoryHost({ now: new Date(NOW) });
  host.onExec = (argv) => {
    if (argv[0] === 'launchctl' && argv[1] === 'print') return { code: 0, stdout: print, stderr: '' };
    if (argv[0] === 'phm') return { code: 0, stdout: status, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return host;
}

function ctx(host: ReturnType<typeof hostWith>): FixContext {
  return { host, dryRun: false, ledger: [] };
}

const CLIMBING = 'runs = 25\nlast exit code = 1\npid = 99\n';
const ADMITTED = [
  'Resident admission: admitted — grant #3 is active until 2026-12-16T00:00:00.000Z',
  'Service: ai.ashlr.daemon running (~/Library/LaunchAgents/ai.ashlr.daemon.plist)',
].join('\n');

describe('launchd crash loop', () => {
  it('admitted grant blocks disable', () => {
    const host = hostWith(CLIMBING, ADMITTED);
    const line = fixLaunchdCrashloop(job({ label: 'ai.ashlr.daemon', authorityGoverned: true, logTail: 'healthy pid' }), ctx(host));
    expect(line?.result).toBe('refused_admitted');
    expect(host.calls.some((argv) => argv[0] === 'phm' && argv[1] === 'authority' && argv[2] === 'resident' && argv[3] === 'status')).toBe(true);
    expect(host.calls.some((argv) => argv.includes('disable') || argv.includes('bootout'))).toBe(false);
    const rq = [...host.files.values()].find((text) => text.includes('refused_admitted'));
    expect(rq).toContain('did not disable');
  });

  it('stale high runs count with flat current runs blocks disable', () => {
    const host = hostWith('runs = 80\nlast exit code = 1\npid = 50\n');
    const line = fixLaunchdCrashloop(job({
      samples: [sample(50, 1), sample(40, 80), sample(2, 80)],
    }), ctx(host));
    expect(line?.result).toBe('refused_stale');
    expect(host.calls.some((argv) => argv.includes('disable') || argv.includes('bootout'))).toBe(false);
  });

  it('recent operator bootstrap blocks disable', () => {
    const recentPlist = hostWith(CLIMBING);
    const plistLine = fixLaunchdCrashloop(job({ plistMtimeMs: NOW - 5 * 60_000 }), ctx(recentPlist));
    expect(plistLine?.result).toBe('refused_operator');
    expect(recentPlist.calls.some((argv) => argv.includes('disable'))).toBe(false);

    const recentRollback = hostWith(CLIMBING);
    const rollbackLine = fixLaunchdCrashloop(job({ rollbackMtimeMs: NOW - 2 * 60_000 }), ctx(recentRollback));
    expect(rollbackLine?.result).toBe('refused_operator');
    expect(recentRollback.calls.some((argv) => argv.includes('disable') || argv.includes('bootout'))).toBe(false);
  });

  it('genuine active loop with no admission disables', () => {
    const host = hostWith(CLIMBING, 'Resident admission: blocked — no active standing grant\nService: ai.ashlr.daemon running\n');
    const context = ctx(host);
    const line = fixLaunchdCrashloop(job({ label: 'ai.ashlr.daemon', authorityGoverned: true }), context);
    expect(line?.result).toBe('applied');
    expect(host.calls).toContainEqual(['launchctl', 'disable', 'gui/501/ai.ashlr.daemon']);
    expect(host.calls).toContainEqual(['launchctl', 'bootout', 'gui/501/ai.ashlr.daemon']);
    const rq = [...host.files.values()].find((text) => text.includes('last exit codes'));
    expect(rq).toContain('9');
    context.ledger.push(line!);
    const second = fixLaunchdCrashloop(job({ label: 'ai.ashlr.daemon', authorityGoverned: true }), context);
    expect(second?.result).toBe('skipped');
    expect(host.calls.filter((argv) => argv[1] === 'disable')).toHaveLength(1);
  });

  it('does not disable a healthy admitted resident at runs=1', () => {
    const host = hostWith('runs = 1\nlast exit code = (never exited)\npid = 4242\n', ADMITTED);
    const line = fixLaunchdCrashloop(job({
      label: 'ai.ashlr.daemon',
      authorityGoverned: true,
      samples: [sample(5, 1, 0)],
      plistMtimeMs: NOW - 2 * 60_000,
    }), ctx(host));
    expect(line?.result === 'applied').toBe(false);
    expect(host.calls.some((argv) => argv.includes('disable') || argv.includes('bootout'))).toBe(false);
  });
});
