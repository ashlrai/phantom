import { describe, expect, it } from 'vitest';
import { releaseOfTitle } from './deriveFleetMergeNotifications.js';

describe('releaseOfTitle', () => {
  it.each([
    ['chore(master): release 3.30.0', '3.30.0'],
    ['chore(main): release 1.2.3', '1.2.3'],
    ['chore(main): release 1.2.3-rc.1', '1.2.3-rc.1'],
    ['release v1.2.3', '1.2.3'],
    ['release v1.2.3-beta.2', '1.2.3-beta.2'],
  ])('extracts the version from %s', (title, version) => {
    expect(releaseOfTitle(title)).toBe(version);
  });

  it.each([
    'chore(master): release 3.30.0 ',
    'chore(master): release 3.30.0\n',
    'chore(other): release 3.30.0',
    'chore(main): release v3.30.0',
    'release 3.30.0',
    'release notes v3.30.0',
    'release v1.2',
    'release v1.2.3-',
    'release v1.2.3+build',
  ])('rejects %j', (title) => {
    expect(releaseOfTitle(title)).toBeNull();
  });
});
