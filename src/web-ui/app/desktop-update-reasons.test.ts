import { describe, expect, it } from 'vitest';
import { describeDesktopUpdateReason } from './desktop-update-reasons.js';

describe('describeDesktopUpdateReason', () => {
  it('explains known reasons', () => {
    expect(describeDesktopUpdateReason('work-active-or-unknown')).toBe('Local work is active or its state could not be confirmed. Installation waits.');
  });
  it('humanises unknown reasons, including inherited object keys', () => {
    expect(describeDesktopUpdateReason('new-update-reason')).toBe('New update reason');
    expect(describeDesktopUpdateReason('constructor')).toBe('Constructor');
  });
  it.each([null, undefined])('reports an unavailable reason for %s', (reason) => {
    expect(describeDesktopUpdateReason(reason)).toBe('reason unavailable');
  });
});
