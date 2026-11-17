import { describe, expect, it } from 'vitest';
import { formatRuntimeStatusLines } from '../src/core/fleet/runtime-status-lines.js';
import type { RuntimeSnapshot } from '../src/core/fleet/runtime-snapshot.js';

const snapshot: RuntimeSnapshot = {
  host: 'host-fake', tailnetName: 'tailnet-fake', installedVersion: '1.0.0',
  pid: 123, uptimeSeconds: 10, platform: 'fake', arch: 'fake', stateRoot: '/fake/private/state',
  lastFleetStateRead: { mtime: '2026-11-14T20:00:00Z', ageSeconds: 12 },
  coordination: { state: 'known', activeClaims: 3, newestReturnAgeSeconds: 7 },
  asOf: '2026-11-14T20:00:12Z', reasons: [],
};

describe('runtime status lines', () => {
  it('formats identity, freshness and measured claims without state paths', () => {
    const lines = formatRuntimeStatusLines(snapshot);
    expect(lines).toEqual([
      'Runtime: host-fake (tailnet-fake) v1.0.0 as of 2026-11-14T20:00:12Z',
      'Fleet state: last write 12s ago',
      'Claims: 3 live, newest return 7s ago',
    ]);
    expect(lines.join('\n')).not.toContain(snapshot.stateRoot);
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it('keeps unavailable evidence UNKNOWN with its reasons', () => {
    expect(formatRuntimeStatusLines({ ...snapshot,
      host: 'UNKNOWN', tailnetName: 'UNKNOWN', installedVersion: 'UNKNOWN',
      lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
      coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN', reason: 'ledger unavailable' },
      reasons: ['lastFleetStateRead: unavailable'],
    })).toEqual([
      'Runtime: UNKNOWN (UNKNOWN) vUNKNOWN as of 2026-11-14T20:00:12Z',
      'Fleet state: UNKNOWN (lastFleetStateRead: unavailable)',
      'Claims: UNKNOWN (ledger unavailable)',
    ]);
  });

  it('shows differing source and installed versions', () => {
    expect(formatRuntimeStatusLines({ ...snapshot, sourceVersion: '1.0.1' })[0]).toContain('v1.0.0 source v1.0.1');
    expect(formatRuntimeStatusLines({ ...snapshot, sourceVersion: '1.0.0' })[0]).not.toContain('source');
  });

  it('escapes Slack mrkdwn delimiters in interpolated values', () => {
    expect(formatRuntimeStatusLines({ ...snapshot, host: '<script>&host-fake' })[0])
      .toContain('&lt;script&gt;&amp;host-fake');
  });

  it('retains a measured zero claim count when no return is available', () => {
    expect(formatRuntimeStatusLines({ ...snapshot,
      coordination: { state: 'known', activeClaims: 0, newestReturnAgeSeconds: 'UNKNOWN', reason: 'no retained return' },
    })[2]).toBe('Claims: 0 live, newest return UNKNOWN (no retained return)');
  });
});
