import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

const fleet = vi.hoisted(() => ({
  snapshot: { schema: 'fleet.v1', generated_at: '2026-10-26T12:00:00.000Z' },
  legacy: { daemon: { activation: { authority: 'observation-only', commandEligible: false, installAuthorized: false } } },
  legacyBuild: vi.fn(),
  build: vi.fn(),
  publish: vi.fn(),
  format: vi.fn(),
  telemetry: vi.fn(),
}));
vi.mock('../src/core/fleet/coding-snapshot.js', () => ({
  buildCodingFleetSnapshot: fleet.build,
  writeCodingFleetSnapshot: fleet.publish,
  formatCodingFleetSnapshot: fleet.format,
}));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/fleet/status.js', () => ({ buildFleetStatus: fleet.legacyBuild }));
vi.mock('../src/core/fleet/coding-telemetry.js', () => ({ emitFleetTelemetry: fleet.telemetry }));
vi.mock('../src/core/providers/coding-cli/scheduler/defaults.js', () => ({
  loadSchedulerConfig: () => ({ posthog: { enabled: false, host: null, apiKey: null } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fleet.build.mockResolvedValue(fleet.snapshot);
  fleet.legacyBuild.mockResolvedValue(fleet.legacy);
  fleet.publish.mockImplementation(() => undefined);
  fleet.format.mockReturnValue('Fleet usage unknown');
});
afterEach(() => { vi.restoreAllMocks(); });

// Real CLI/PATH and private-file coverage lives in the serialized gateway suite.
describe('fleet status command dispatch', () => {
  it('preserves operational activation-readiness JSON by default', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--json'])).toBe(0);
    expect(fleet.legacyBuild).toHaveBeenCalledOnce();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(fleet.legacy);
    expect(fleet.build).not.toHaveBeenCalled();
    expect(fleet.publish).not.toHaveBeenCalled();
  });

  it('rejects incompatible status modes before reading or writing evidence', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--coding', '--legacy', '--json'])).toBe(2);
    expect(fleet.legacyBuild).not.toHaveBeenCalled();
    expect(fleet.build).not.toHaveBeenCalled();
    expect(fleet.publish).not.toHaveBeenCalled();
  });

  it('publishes and emits the same versioned snapshot in JSON mode', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--coding', '--json'])).toBe(0);
    expect(fleet.build).toHaveBeenCalledOnce();
    expect(fleet.publish).toHaveBeenCalledWith(fleet.snapshot);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(fleet.snapshot);
    expect(fleet.format).not.toHaveBeenCalled();
  });

  it('formats the published snapshot for human output', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--coding'])).toBe(0);
    expect(fleet.publish).toHaveBeenCalledWith(fleet.snapshot);
    expect(fleet.format).toHaveBeenCalledWith(fleet.snapshot);
    expect(out).toHaveBeenCalledWith('Fleet usage unknown\n');
  });

  it('refuses unknown options before collecting or writing evidence', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--coding', '--jsno'])).toBe(2);
    expect(fleet.build).not.toHaveBeenCalled();
    expect(fleet.publish).not.toHaveBeenCalled();
  });

  it('prints help without collecting or writing evidence', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleet(['status', '--coding', '--help'])).toBe(0);
    expect(fleet.build).not.toHaveBeenCalled();
    expect(fleet.publish).not.toHaveBeenCalled();
  });

  it.each(['collection', 'publication'])('reports %s failure without exposing private exception text', async failure => {
    const privateDetail = 'private-fleet-error-detail';
    if (failure === 'collection') fleet.build.mockRejectedValue(new Error(privateDetail));
    else fleet.publish.mockImplementation(() => { throw new Error(privateDetail); });
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleet(['status', '--coding', '--json'])).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]![0])).toContain('snapshot unavailable');
    expect(String(err.mock.calls[0]![0])).not.toContain(privateDetail);
    expect(fleet.telemetry).not.toHaveBeenCalled();
  });
});
