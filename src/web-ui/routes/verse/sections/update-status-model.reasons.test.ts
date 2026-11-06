import { describe, expect, it } from 'vitest';
import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import { describeUpdateStatus } from './update-status-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const server: UpdateServerStatus = { v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: null, headAt: null, originSha: null, branch: 'master', behind: 1, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true };
const native: DesktopUpdateState = { phase: 'adoption-held', enabled: true, version: '3.30.0', reason: 'work-active-or-unknown', bytesReceived: 0, bytesTotal: null };
const base = { native, server, appVersion: '1.0.0', desktopVersion: null, now: 0 };

describe('desktop update status explanations', () => {
  it('explains held and failed updates', () => {
    expect(describeUpdateStatus(base)).toMatchObject({ headline: 'Update held: Local work is active or its state could not be confirmed. Installation waits.', tone: 'warning' });
    expect(describeUpdateStatus({ ...base, native: { ...native, phase: 'failed', reason: 'artifact-mismatch' } })).toMatchObject({ headline: 'Update failed: The downloaded bytes did not match the signed release. Installation stays on hold.', tone: 'danger' });
    expect(describeUpdateStatus({ ...base, native: { ...native, phase: 'failed', reason: 'new-reason' } }).headline).toBe('Update failed: New reason');
  });
  it('uses the singular for one commit behind', () => {
    expect(describeUpdateStatus({ ...base, native: null }).headline).toBe('1 commit behind master · ready to fast-forward');
  });
  it('prioritizes an available native version over git facts', () => {
    expect(describeUpdateStatus({ ...base, native: { ...native, phase: 'available' } })).toMatchObject({ headline: 'Update 3.30.0 available · downloads when idle', tone: 'info' });
    expect(describeUpdateStatus({ ...base, native: { ...native, phase: 'available', version: null } }).headline).toBe('Update available · downloads when idle');
  });
});
