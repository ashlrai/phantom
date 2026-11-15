import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStatusDigest } from '../src/cli/fleet-status-digest.js';
import type { StatusDigestSources } from '../src/core/leader/status-digest-sources.js';

const sources: StatusDigestSources = {
  installedVersion: () => null,
  publishedVersion: async () => '1.2.3',
  mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
  runsState: async () => { throw new Error('unavailable'); },
  needs: () => ({ status: 'missing', items: [] }),
  inbox: async () => ({ sourceState: 'healthy', entries: [] }),
  // The sixth claims line postdates this suite's five-line counts; the
  // undefined override keeps both assertions exactly as written.
  workClaims: undefined,
};
const now = () => new Date('2026-11-11T12:00:00Z');

afterEach(() => vi.restoreAllMocks());

describe('fleet status-digest', () => {
  it('prints the owner reply with five digest lines', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStatusDigest(['--runs-dir', '/test'], { sources, now })).toBe(0);
    const lines = String(log.mock.calls[0]![0]).split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^Phantom status,/);
  });

  it('preserves unknown facts in JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStatusDigest(['--json'], { sources, now })).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]![0]));
    expect(result.schema).toBe('phantom.status-digest.v1');
    expect(result.at).toBe(now().toISOString());
    expect(result.lines).toHaveLength(5);
    expect(result.facts.installedVersion).toEqual({ ok: false, reason: 'installed app version not readable' });
  });

  it('rejects invalid flags with one usage line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetStatusDigest(['--bad'], { sources, now })).toBe(2);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]![0])).toMatch(/^Usage: [^\n]+$/);
  });
});
