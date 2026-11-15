import { describe, expect, it, vi } from 'vitest';
import { buildCapabilityAudit } from '../src/core/fleet/capability-audit.js';
import { cmdFleetCapabilityAudit } from '../src/cli/fleet-capability-audit.js';
import { cmdFleet } from '../src/cli/fleet-entry.js';

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

  it('prints the read-only catalog and keeps GATES-held surfaces out of implementable work', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdFleet(['capability-audit', '--json'])).toBe(0);
      const report = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        counts: { gatesHeld: number; implementableNow: number };
        implementableNow: Array<{ status: string }>;
      };
      expect(report.counts.gatesHeld).toBeGreaterThan(0);
      expect(report.implementableNow.every((gap) => gap.status !== 'gates-held')).toBe(true);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
