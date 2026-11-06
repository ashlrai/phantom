import { describe, expect, it, vi } from 'vitest';
import { ENGINE_ADMISSION_POLICY, engineAdmissionView, readEngineAdmission }
  from '../src/core/fleet/engine-admission-view.js';

const POLICY = { source: 'kern.memorystatus_vm_pressure_level', allow_level: 1, hold_levels: [2, 4] };

describe('engineAdmissionView', () => {
  it('reports the gate as absent off macOS and never consults the reader', () => {
    for (const platform of ['linux', 'win32', 'freebsd']) {
      expect(engineAdmissionView({ freePercent: 50, swapGb: 1, pressureLevel: 1 }, platform)).toEqual({
        gated: false, allowed: null, free_pct: null, swap_gb: null, pressure_level: null,
        reason: 'Engine memory gate runs on macOS only.', policy: POLICY,
      });
    }
    const read = vi.fn();
    expect(readEngineAdmission(read, 'linux')).toMatchObject({ gated: false, allowed: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('allows normal pressure even with low raw free and historical swap', () => {
    expect(engineAdmissionView({ freePercent: 26, swapGb: 5.8, pressureLevel: 1 }, 'darwin')).toEqual({
      gated: true, allowed: true, free_pct: 26, swap_gb: 5.8, pressure_level: 1, reason: null, policy: POLICY,
    });
  });

  it.each([2, 4] as const)('holds pressure level %i even with high raw free', (pressureLevel) => {
    const view = engineAdmissionView({ freePercent: 80, swapGb: 0, pressureLevel }, 'darwin');
    expect(view).toMatchObject({ gated: true, allowed: false, free_pct: 80, swap_gb: 0, pressure_level: pressureLevel, policy: POLICY });
    expect(view.reason).toBeTruthy();
  });

  it('fails closed when the reading is unavailable or invalid', () => {
    expect(engineAdmissionView(null, 'darwin')).toEqual({
      gated: true, allowed: false, free_pct: null, swap_gb: null, pressure_level: null,
      reason: 'Host memory telemetry unavailable; launch held.', policy: POLICY,
    });
    expect(engineAdmissionView({ freePercent: NaN, swapGb: 1, pressureLevel: 1 }, 'darwin').allowed).toBe(false);
    expect(engineAdmissionView({ freePercent: 101, swapGb: 1, pressureLevel: 1 }, 'darwin').allowed).toBe(false);
  });
});

describe('readEngineAdmission', () => {
  it('returns the gate unavailable verdict when the reader throws', () => {
    expect(readEngineAdmission(() => { throw new Error('private detail'); }, 'darwin')).toEqual({
      gated: true, allowed: false, free_pct: null, swap_gb: null, pressure_level: null,
      reason: 'Host memory telemetry unavailable; launch held.', policy: POLICY,
    });
  });

  it('projects the injected reading through the gate', () => {
    expect(readEngineAdmission(() => ({ freePercent: 62.4, swapGb: 0.75, pressureLevel: 1 }), 'darwin'))
      .toMatchObject({ gated: true, allowed: true, free_pct: 62.4, swap_gb: 0.75, pressure_level: 1, reason: null });
    expect(readEngineAdmission(() => null, 'darwin')).toMatchObject({ gated: true, allowed: false });
  });

  it('describes the actual kernel policy', () => { expect(ENGINE_ADMISSION_POLICY).toEqual(POLICY); });
});
