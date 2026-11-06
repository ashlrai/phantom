import { describe, expect, it } from 'vitest';
import type { PairedDevice, PairedDevicesSnapshot } from '../sections/paired-devices-model.js';
import { phoneTile } from './hub-phone-tile.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const device = (minutes: number | null, revoked = false): PairedDevice => ({
  id: 'dev-fake-1', label: 'Fake phone', email: 'fake@example.com', subject: 'fake-subject', act: false,
  createdAt: '2026-01-01T00:00:00Z', lastUsedAt: minutes === null ? null : new Date(now - minutes * 60_000).toISOString(),
  revokedAt: revoked ? '2026-10-01T00:00:00Z' : null,
});
const snapshot = (...devices: PairedDevice[]): PairedDevicesSnapshot => ({ v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', devices });
const pending = { gateway: 'running' as const, approvals: [] };

describe('phoneTile', () => {
  it('hides while loading or when paired devices are not in this build', () => {
    expect(phoneTile(null, pending, now)).toBeNull();
    expect(phoneTile({ kind: 'notInBuild' }, pending, now)).toBeNull();
    expect(phoneTile(snapshot(), null, now)).toBeNull();
  });
  it('shows not paired when there are no active devices', () => {
    expect(phoneTile(snapshot(device(1, true)), pending, now)).toMatchObject({ title: 'Phone', reading: 'Not paired', tone: 'neutral' });
    expect(phoneTile(snapshot(), pending, now)?.reading).toBe('Not paired');
  });
  it('uses the most recent active read and the specified age boundaries', () => {
    expect(phoneTile(snapshot(device(1500), device(59), device(1, true)), pending, now))
      .toMatchObject({ reading: '2 paired · last read 59 m ago', tone: 'ok' });
    expect(phoneTile(snapshot(device(60)), pending, now)?.tone).toBe('neutral');
    expect(phoneTile(snapshot(device(1440)), pending, now)?.tone).toBe('neutral');
    expect(phoneTile(snapshot(device(1500)), pending, now)).toMatchObject({ reading: '1 paired · last read 1 d ago', tone: 'warn' });
    expect(phoneTile(snapshot(device(null)), pending, now)).toMatchObject({ reading: '1 paired · last read never', tone: 'neutral' });
  });
  it('prioritizes approvals and uses the Needs-you wording in the tooltip', () => {
    const approval = { id: 'dev-fake-1', label: 'Fake', email: 'fake@example.com' };
    const tile = phoneTile(snapshot(device(1)), { gateway: 'running', approvals: [approval, approval] }, now);
    expect(tile).toMatchObject({ title: 'Phone: approve', reading: '2 waiting for approval', tone: 'danger' });
    expect(tile?.detail).toContain('waiting for your approval');
    expect(tile?.reading.length).toBeLessThan(48);
  });
  it('does not claim there are no approvals when that endpoint is missing', () => {
    expect(phoneTile(snapshot(device(1)), { kind: 'notInBuild' }, now)).toMatchObject({ reading: 'Phone status unavailable', tone: 'warn' });
  });
});
