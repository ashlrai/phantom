import { describe, expect, it } from 'vitest';
import { compareReleaseTags, releaseGapText, releaseNotesUrl } from './release-gap-model.js';

describe('release gap', () => {
  it.each([
    ['3.29.15', 'v3.30.0', 'behind'],
    ['3.30.0', 'v3.30.0', 'latest'],
    ['3.30.1', 'v3.30.0', 'ahead'],
    ['3.30.0-rc.1+build', 'v3.30.0', 'latest'],
    ['3.30.0', null, 'unknown'],
    ['3.30.0', 'not-a-version', 'unknown'],
    ['bad', 'v3.30.0', 'unknown'],
  ] as const)('compares %s with %s', (installed, latest, state) => {
    expect(compareReleaseTags(installed, latest)).toEqual({ state, installed, latest });
  });

  it('describes the result and encodes release links', () => {
    expect(releaseGapText(compareReleaseTags('3.29.15', 'v3.30.0'))).toBe('Installed 3.29.15 · latest release v3.30.0');
    expect(releaseGapText(compareReleaseTags('3.30.0', 'v3.30.0'))).toBe('Installed is the latest release');
    expect(releaseGapText(compareReleaseTags('3.30.0', null))).toBe('Release list unavailable');
    expect(releaseNotesUrl('v3.30.0')).toBe('https://github.com/ashlrai/phantom/releases/tag/v3.30.0');
    expect(releaseNotesUrl('v3/alpha')).toBe('https://github.com/ashlrai/phantom/releases/tag/v3%2Falpha');
  });
});
