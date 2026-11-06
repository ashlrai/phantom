import { describe, expect, it } from 'vitest';
import { behindLines } from './update-behind-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const status: UpdateServerStatus = { v: 1, sourceState: 'healthy', installedVersion: null, headSha: null,
  headAt: null, originSha: null, branch: 'master', behind: 12, ahead: 0, dirty: false, lastFetchAt: null,
  processStartedAt: null, uptimeSeconds: 1, canFastForward: true };
describe('behindLines', () => {
  it.each([undefined, null, []])('hides absent subjects: %s', (behindSubjects) => {
    expect(behindLines({ ...status, behindSubjects })).toBeNull();
  });
  it('handles unavailable and older server replies', () => {
    expect(behindLines(null)).toBeNull();
    expect(behindLines({ kind: 'notInBuild' })).toBeNull();
    expect(behindLines(status)).toBeNull();
  });
  it('counts all remaining commits and caps the disclosure', () => {
    expect(behindLines({ ...status, behindSubjects: ['one', 'two', 'three', 'four', 'five', 'six'] }))
      .toEqual({ first: 'one', moreCount: 11, all: ['one', 'two', 'three', 'four', 'five'] });
  });
  it('handles a single subject', () => {
    expect(behindLines({ ...status, behind: 1, behindSubjects: ['one'] }))
      .toEqual({ first: 'one', moreCount: 0, all: ['one'] });
  });
});
