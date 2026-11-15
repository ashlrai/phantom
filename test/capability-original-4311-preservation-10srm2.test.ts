import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { buildCapabilityAudit, type CapabilityAuditReport } from '../src/core/fleet/capability-audit.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('original #4311 capability audit through fleet dispatch', () => {
  it('returns the static catalog contract at a controlled time', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    vi.useFakeTimers().setSystemTime(now);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleet(['capability-audit', '--json'])).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const report = JSON.parse(String(log.mock.calls[0]![0])) as CapabilityAuditReport;
    expect(report).toEqual(buildCapabilityAudit(now));
    expect(report.schema).toBe('capability-audit.v1');
    expect(report.surfaces.find(s => s.id === 'apps-open-focus')?.notes).toContain('availability is not assessed');
    expect(report.surfaces.find(s => s.id === 'gui-tcc-grants')?.status).toBe('gates-held');
    expect(report.implementableNow.every(g => g.gatesSafe && g.implementNow)).toBe(true);
    expect(report.gaps.map(g => g.leverage)).toEqual(report.gaps.map(g => g.leverage).sort((a, b) => b - a));
    log.mockClear();
    expect(await cmdFleet(['capability-audit', '--help'])).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('not evidence of live availability, permissions or authorization');
  });

  it.each([['--json', '--json'], ['--help', '--json'], ['--json', '-h']])(
    'rejects invalid arguments %s %s', async (...args) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleet(['capability-audit', ...args])).toBe(2);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
    },
  );

  it('isolates mutable records across reports and report collections', () => {
    const first = buildCapabilityAudit();
    const second = buildCapabilityAudit();
    const id = first.implementableNow[0]!.id;
    const originalRoute = second.gaps.find(g => g.id === id)!.route;
    first.implementableNow[0]!.route = 'mutated';
    first.surfaces[0]!.agent = 'mutated';
    expect(first.gaps.find(g => g.id === id)!.route).toBe(originalRoute);
    expect(second.surfaces[0]!.agent).not.toBe('mutated');
    expect(buildCapabilityAudit().surfaces[0]!.agent).not.toBe('mutated');
  });
});
