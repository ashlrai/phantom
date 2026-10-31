import { describe, expect, it } from 'vitest';
import { deriveUpdateNotifications as derive } from './deriveUpdateNotifications.js';
import type { DesktopUpdateState } from '../../app/desktop-updates.js';
import type { UpdateServerStatus } from '../../routes/verse/sections/update-status-queries.js';

const now = Date.parse('2026-10-31T12:15:00Z');
const sha = (c: string) => c.repeat(40);

const native = (phase: DesktopUpdateState['phase'], over: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  phase, enabled: true, version: '3.30.0', bytesReceived: 0, bytesTotal: null, reason: null, ...over,
});

const server = (over: Partial<UpdateServerStatus> & Record<string, unknown> = {}): UpdateServerStatus => ({
  v: 1, sourceState: 'healthy', installedVersion: '3.29.4',
  headSha: sha('a'), headAt: '2026-10-31T10:00:00Z', originSha: sha('b'), branch: 'master',
  behind: 0, ahead: 0, dirty: false, lastFetchAt: '2026-10-31T12:10:00Z',
  processStartedAt: '2026-10-31T08:00:00Z', uptimeSeconds: 15_300, canFastForward: false, ...over,
});

const lastApply = (over: Record<string, unknown> = {}) => ({
  outcome: 'failed', reason: 'update failed', startedAt: '2026-10-31T12:00:00Z',
  finishedAt: '2026-10-31T12:01:00Z', fromCommit: sha('a'), toCommit: sha('b'),
  restartRequired: false, restartMode: 'manual', ...over,
});

describe('update notifications — native updater', () => {
  it.each(['staged', 'waiting-for-idle', 'waiting-for-app-quit'] as const)(
    'raises one ready item for the %s phase', (phase) => {
      expect(derive(null, now, native(phase))).toEqual([expect.objectContaining({
        id: 'update-ready:3.30.0', category: 'action-required', severity: 'high',
        title: 'Phantom 3.30.0 is ready to install', actionLabel: 'Update now',
      })]);
    });

  it('raises a held item when the guard blocks install', () => {
    expect(derive(null, now, native('adoption-held', { reason: 'work-active-or-unknown' }))).toEqual([
      expect.objectContaining({ id: 'update-held:3.30.0', severity: 'high',
        title: 'Update to 3.30.0 is held', actionLabel: 'Open Updates',
        detail: 'Local work is active or its state could not be confirmed. Installation waits.' }),
    ]);
  });

  it('raises one failed item with the described reason and a reason-keyed id', () => {
    const [item] = derive(null, now, native('failed', { reason: 'artifact-mismatch' }));
    expect(item).toMatchObject({ category: 'action-required', severity: 'critical', actionLabel: 'Open Updates',
      title: 'Update to 3.30.0 failed: The downloaded bytes did not match the signed release. Installation stays on hold.' });
    expect(item?.id).toMatch(/^update-failed:3\.30\.0:[a-z0-9]+$/);
  });

  it.each(['checking', 'idle', 'available', 'downloading', 'installing', 'installed', 'current', 'disabled', 'uncommissioned'] as const)(
    'stays silent while the update is %s', (phase) => {
      expect(derive(null, now, native(phase))).toEqual([]);
    });

  it('falls back when the native update names no version', () => {
    expect(derive(null, now, native('staged', { version: null }))[0]).toMatchObject({
      id: 'update-ready:unknown', title: 'Phantom update is ready to install' });
  });
});

describe('update notifications — server self-update probe', () => {
  const ready = server({ behind: 3, canFastForward: true });

  it('raises one ready item when a clean fast-forward is provable', () => {
    expect(derive(ready, now)).toEqual([expect.objectContaining({
      id: 'update-ready:bbbbbbb', category: 'action-required', severity: 'high',
      title: 'Phantom bbbbbbb is ready to install', actionLabel: 'Update now',
      detail: '3 commits behind origin/master — the tree is clean and a fast-forward is provable.',
      ts: '2026-10-31T12:10:00Z' })]);
  });

  it.each([
    server({ behind: 0 }),                        // up to date — idle
    server({ behind: 2, canFastForward: false }), // cannot apply (diverged)
    server({ behind: 2, canFastForward: true, dirty: true }),
    server({ sourceState: 'unavailable' }),
  ])('stays silent for an update that is not ready: %j', (status) => {
    expect(derive(status, now)).toEqual([]);
  });

  it('treats an unknown dirty flag the way UpdateNowButton does — still applicable', () => {
    // The button enables on `dirty !== true`; the notification agrees so the
    // bell never advertises an update the row would refuse to apply.
    const status = server({ behind: 2, canFastForward: true, dirty: null });
    expect(derive(status, now).map((n) => n.id)).toEqual(['update-ready:bbbbbbb']);
  });

  it('raises one failed item from the durable apply record, reason included', () => {
    const status = server({ lastApply: lastApply() }) as UpdateServerStatus;
    const [item] = derive(status, now);
    expect(item).toMatchObject({ category: 'action-required', severity: 'critical',
      title: 'Update to bbbbbbb failed: update failed', actionLabel: 'Open Updates',
      ts: '2026-10-31T12:01:00Z' });
    expect(item?.id).toMatch(/^update-failed:bbbbbbb:[a-z0-9]+$/);
  });

  it('reports a refused apply as refused, with its reason', () => {
    const status = server({ lastApply: lastApply({ outcome: 'refused', reason: 'dirty tree' }) }) as UpdateServerStatus;
    expect(derive(status, now)).toEqual([expect.objectContaining({
      title: 'Update to bbbbbbb refused: dirty tree' })]);
  });

  it.each(['updated', 'already-current'])('stays silent once the apply is %s', (outcome) => {
    const status = server({ lastApply: lastApply({ outcome, reason: null, restartRequired: true }) }) as UpdateServerStatus;
    expect(derive(status, now)).toEqual([]);
  });

  it('lets a stale apply record age out instead of nagging forever', () => {
    const status = server({ lastApply: lastApply({ finishedAt: '2026-10-30T11:00:00Z' }) }) as UpdateServerStatus;
    expect(derive(status, now)).toEqual([]);
  });
});

describe('update notifications — stability and hygiene', () => {
  it('re-derives the same item for the same version (dedupe by id), a new version a new item', () => {
    const first = derive(null, now, native('staged'));
    const again = derive(null, now + 60_000, native('staged'));
    expect(again.map((n) => n.id)).toEqual(first.map((n) => n.id));
    expect(derive(null, now, native('staged', { version: '3.30.1' })).map((n) => n.id))
      .toEqual(['update-ready:3.30.1']);
  });

  it('keeps both channels when a native stage and a fast-forward are both pending', () => {
    const items = derive(server({ behind: 1, canFastForward: true }), now, native('staged'));
    expect(items.map((n) => n.id).sort()).toEqual(['update-ready:3.30.0', 'update-ready:bbbbbbb']);
  });

  it('never lets a reason carry a path or token run, and truncates at 140 chars', () => {
    const raw = `step failed at /Users/mason/secret/token.txt tail ${'k'.repeat(80)}`;
    const status = server({ lastApply: lastApply({ reason: raw }) }) as UpdateServerStatus;
    const [item] = derive(status, now);
    expect(item?.title).not.toContain('/Users');
    expect(item?.title).not.toContain('k'.repeat(24));
    expect(item?.title).toBe('Update to bbbbbbb failed: step failed at … tail …');
  });

  it('truncates a long reason at 140 characters', () => {
    const raw = `apply could not finish ${'because '.repeat(40)}`;
    const status = server({ lastApply: lastApply({ reason: raw }) }) as UpdateServerStatus;
    const reason = derive(status, now)[0]!.title.split('failed: ')[1]!;
    expect(reason.length).toBe(140);
    expect(reason.endsWith('…')).toBe(true);
  });

  it.each([null, { kind: 'notInBuild' } as const])('emits nothing for %j', (status) => {
    expect(derive(status, now)).toEqual([]);
    expect(derive(status, now, native('installing'))).toEqual([]);
  });
});
