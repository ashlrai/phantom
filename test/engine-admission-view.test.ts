import { describe, expect, it, vi } from 'vitest';
import { assessHostHeadroom } from '../src/core/run/host-headroom.js';
import { ENGINE_ADMISSION_THRESHOLDS, engineAdmissionView, readEngineAdmission }
  from '../src/core/fleet/engine-admission-view.js';

const THRESHOLDS = { hold_below_free_pct: 30, hold_above_swap_gb: 8, resume_free_pct: 35, resume_swap_gb: 6 };

describe('engineAdmissionView', () => {
  it('reports the gate as absent off macOS and never consults the reader', () => {
    for (const platform of ['linux', 'win32', 'freebsd']) {
      expect(engineAdmissionView({ freePercent: 50, swapGb: 1 }, platform)).toEqual({
        gated: false, allowed: null, free_pct: null, swap_gb: null,
        reason: 'Engine memory gate runs on macOS only.', thresholds: THRESHOLDS,
      });
    }
    const read = vi.fn();
    expect(readEngineAdmission(read, 'linux')).toMatchObject({ gated: false, allowed: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('allows a launch when the reading clears both hold thresholds', () => {
    expect(engineAdmissionView({ freePercent: 50, swapGb: 1 }, 'darwin')).toEqual({
      gated: true, allowed: true, free_pct: 50, swap_gb: 1, reason: null, thresholds: THRESHOLDS,
    });
  });

  it('holds a launch below 30% free and reports the gate reason', () => {
    const view = engineAdmissionView({ freePercent: 29.9, swapGb: 1 }, 'darwin');
    expect(view).toMatchObject({ gated: true, allowed: false, free_pct: 29.9, swap_gb: 1, thresholds: THRESHOLDS });
    expect(view.reason).toContain('29.9% free');
    expect(view.reason).toContain('launch held until at least 35% free and at most 6 GiB swap');
  });

  it('holds a launch above 8 GiB swap', () => {
    const view = engineAdmissionView({ freePercent: 50, swapGb: 8.5 }, 'darwin');
    expect(view).toMatchObject({ gated: true, allowed: false, free_pct: 50, swap_gb: 8.5 });
    expect(view.reason).toContain('8.50 GiB swap');
  });

  it('fails closed with the gate reason when the reading is null or invalid', () => {
    expect(engineAdmissionView(null, 'darwin')).toEqual({
      gated: true, allowed: false, free_pct: null, swap_gb: null,
      reason: 'Host memory telemetry unavailable; launch held.', thresholds: THRESHOLDS,
    });
    expect(engineAdmissionView({ freePercent: NaN, swapGb: 1 }, 'darwin').allowed).toBe(false);
    expect(engineAdmissionView({ freePercent: 101, swapGb: 1 }, 'darwin').allowed).toBe(false);
  });
});

describe('readEngineAdmission', () => {
  it('returns the gate unavailable verdict when the reader throws', () => {
    const view = readEngineAdmission(() => { throw new Error('vm_stat exploded'); }, 'darwin');
    expect(view).toEqual({
      gated: true, allowed: false, free_pct: null, swap_gb: null,
      reason: 'Host memory telemetry unavailable; launch held.', thresholds: THRESHOLDS,
    });
  });

  it('projects the injected reading through the gate', () => {
    expect(readEngineAdmission(() => ({ freePercent: 62.4, swapGb: 0.75 }), 'darwin'))
      .toMatchObject({ gated: true, allowed: true, free_pct: 62.4, swap_gb: 0.75, reason: null });
    expect(readEngineAdmission(() => null, 'darwin')).toMatchObject({ gated: true, allowed: false });
  });
});

describe('admission threshold constants', () => {
  it('pin to assessHostHeadroom hold and resume boundaries', () => {
    const t = ENGINE_ADMISSION_THRESHOLDS;
    expect(t).toEqual(THRESHOLDS);
    expect(assessHostHeadroom({ freePercent: t.hold_below_free_pct, swapGb: t.hold_above_swap_gb }).allowed).toBe(true);
    expect(assessHostHeadroom({ freePercent: t.hold_below_free_pct - 0.01, swapGb: t.hold_above_swap_gb }).allowed).toBe(false);
    expect(assessHostHeadroom({ freePercent: t.hold_below_free_pct, swapGb: t.hold_above_swap_gb + 0.01 }).allowed).toBe(false);
    expect(assessHostHeadroom({ freePercent: t.resume_free_pct, swapGb: t.resume_swap_gb }, true).allowed).toBe(true);
    expect(assessHostHeadroom({ freePercent: t.resume_free_pct - 0.01, swapGb: t.resume_swap_gb }, true).allowed).toBe(false);
    expect(assessHostHeadroom({ freePercent: t.resume_free_pct, swapGb: t.resume_swap_gb + 0.01 }, true).allowed).toBe(false);
  });
});
