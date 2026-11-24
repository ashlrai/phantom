import { describe, expect, it } from 'vitest';
import {
  RECORDED_HOST_CONSTRAINTS_PROVENANCE as P,
  explainRecordedHostConstraints as explain,
  type RecordedHostEvidence,
} from '../src/core/providers/coding-cli/recorded-host-constraints.js';

const ok: RecordedHostEvidence = { host: 'mac', diskFreeGb: 50, batteryPercent: 80, diskFloorGb: 20, batteryFloorPercent: 30 };

describe('recorded host constraints (PR #5952 hostBlocks)', () => {
  it('disk below/equal/above floor', () => {
    expect(explain({ ...ok, diskFreeGb: 19.9 })).toMatchObject({ status: 'blocked', reasons: ['disk-below-floor'] });
    expect(explain({ ...ok, diskFreeGb: 20 }).status).toBe('not-blocked');
    expect(explain({ ...ok, diskFreeGb: 20.1 }).status).toBe('not-blocked');
  });
  it('battery below/equal/above floor', () => {
    expect(explain({ ...ok, batteryPercent: 29 })).toMatchObject({ status: 'blocked', reasons: ['battery-below-floor'] });
    expect(explain({ ...ok, batteryPercent: 30 }).status).toBe('not-blocked');
    expect(explain({ ...ok, batteryPercent: 31 }).status).toBe('not-blocked');
  });
  it('reports both reasons', () => {
    expect(explain({ ...ok, diskFreeGb: 1, batteryPercent: 1 })).toMatchObject({
      status: 'blocked',
      reasons: ['disk-below-floor', 'battery-below-floor'],
    });
  });
  it('remote hosts bypass without Mac evidence', () => {
    expect(explain({ host: 'remote' }).status).toBe('bypassed');
    expect(explain({ host: 'ssh', diskFreeGb: 0, diskFloorGb: 20 }).status).toBe('bypassed');
  });
  it('missing measurement or floor is unknown, not invented', () => {
    expect(explain({ ...ok, batteryPercent: null })).toMatchObject({ status: 'unknown', missing: ['batteryPercent'] });
    expect(explain({ ...ok, diskFloorGb: undefined })).toMatchObject({ status: 'unknown', missing: ['diskFloorGb'] });
    expect(explain({ host: 'mac' })).toMatchObject({ status: 'unknown', missing: ['diskFreeGb', 'diskFloorGb', 'batteryPercent', 'batteryFloorPercent'] });
  });
  it('known block wins over a missing other measurement', () => {
    expect(explain({ ...ok, diskFreeGb: 5, batteryPercent: null }).status).toBe('blocked');
    expect(explain({ ...ok, batteryPercent: 5, diskFreeGb: null }).status).toBe('blocked');
  });
  it('accepts zero values', () => {
    expect(explain({ host: 'mac', diskFreeGb: 0, diskFloorGb: 0, batteryPercent: 0, batteryFloorPercent: 0 }).status).toBe('not-blocked');
    expect(explain({ ...ok, diskFreeGb: 0 }).status).toBe('blocked');
  });
  it('rejects invalid supplied values', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      expect(() => explain({ ...ok, diskFreeGb: bad })).toThrow(RangeError);
      expect(() => explain({ ...ok, diskFloorGb: bad })).toThrow(RangeError);
    }
    for (const bad of [NaN, -0.1, 100.1, Infinity]) {
      expect(() => explain({ ...ok, batteryPercent: bad })).toThrow(RangeError);
      expect(() => explain({ ...ok, batteryFloorPercent: bad })).toThrow(RangeError);
    }
  });
  it('is deterministic, immutable, and historical-only with provenance', () => {
    const input = Object.freeze({ ...ok, diskFreeGb: 1 });
    const a = explain(input);
    expect(explain(input)).toEqual(a);
    expect(input).toEqual({ ...ok, diskFreeGb: 1 });
    for (const r of [a, explain(ok), explain({ host: 'x' }), explain({ host: 'mac' })]) {
      expect(r.historicalOnly).toBe(true);
      expect(r.provenance).toEqual({ sourcePr: 5952, sourceSha: P.sourceSha, basis: 'historical-offline' });
    }
    expect(P.sourceSha).toBe('3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886');
  });
});
