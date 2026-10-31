import { describe, expect, it } from 'vitest';
import { versionSkewNote } from './version-skew.js';

describe('versionSkewNote', () => {
  it('prioritizes a stale interface over a stale desktop', () => {
    expect(versionSkewNote({ desktop: '3.29.0', iface: '3.29.15', server: '3.30.0' })).toEqual({
      text: 'This window shows interface 3.29.15 but Phantom 3.30.0 is running · reload to use it', tone: 'warning',
    });
  });
  it('explains an older desktop', () => {
    expect(versionSkewNote({ desktop: '3.29.15', iface: '3.30.0', server: '3.30.0' })).toEqual({
      text: 'Desktop 3.29.15 is older than Phantom 3.30.0 · install the desktop update when offered', tone: 'warning',
    });
  });
  it('explains a newer desktop', () => {
    expect(versionSkewNote({ desktop: '4.0.0', iface: '3.30.0', server: '3.30.0' })).toEqual({
      text: 'Desktop 4.0.0 is ahead of the running Phantom 3.30.0 · the sidecar restarts on the new build when idle', tone: 'info',
    });
  });
  it('ignores prerelease and build metadata and compares numeric components', () => {
    expect(versionSkewNote({ desktop: '3.30.0-beta.1', iface: '3.30.0+build', server: '3.30.0' })).toBeNull();
    expect(versionSkewNote({ desktop: null, iface: '3.9.99', server: '3.10.0-rc.1' })?.tone).toBe('warning');
  });
  it('returns nothing when versions agree or the server or desktop is unknown', () => {
    expect(versionSkewNote({ desktop: '3.30.0', iface: '3.30.0', server: '3.30.0' })).toBeNull();
    expect(versionSkewNote({ desktop: null, iface: '3.30.0', server: '3.30.0' })).toBeNull();
    expect(versionSkewNote({ desktop: '3.29.0', iface: '3.30.0', server: null })).toBeNull();
  });
  it.each([
    { desktop: 'bad', iface: '3.30.0', server: '3.30.0' },
    { desktop: null, iface: '3.30', server: '3.30.0' },
    { desktop: null, iface: '3.30.0', server: 'v3.30.0' },
    { desktop: null, iface: '3.30.0', server: '9007199254740992.0.0' },
  ])('does not infer skew from invalid versions: $desktop / $iface / $server', (versions) => {
    expect(versionSkewNote(versions)).toBeNull();
  });
});
