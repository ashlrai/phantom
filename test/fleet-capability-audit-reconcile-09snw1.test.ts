import { describe, expect, it, vi } from 'vitest';
import { buildCapabilityAudit } from '../src/core/fleet/capability-audit.js';
import { cmdFleetCapabilityAudit } from '../src/cli/fleet-capability-audit.js';
import { cmdFleet } from '../src/cli/fleet.js';

describe('capability audit reconciliation', () => {
  it('isolates returned records across arrays and reports', () => {
    const a = buildCapabilityAudit(new Date('2026-01-01T00:00:00Z'));
    const b = buildCapabilityAudit(new Date('2026-01-01T00:00:00Z'));
    a.implementableNow[0]!.route = 'changed';
    expect(a.gaps[0]!.route).not.toBe('changed');
    a.surfaces[0]!.agent = 'changed';
    expect(b.surfaces[0]!.agent).not.toBe('changed');
  });

  it('rejects duplicate and mixed help arguments without side effects', async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    expect(await cmdFleetCapabilityAudit(['--json', '--json'], { output })).toBe(2);
    expect(await cmdFleetCapabilityAudit(['--help', '--json'], { output })).toBe(2);
    expect(output.log).not.toHaveBeenCalled();
  });

  it('exposes the current convention dispatch blocker', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdFleet(['capability-audit', '--json'])).not.toBe(0);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
