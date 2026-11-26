import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStatusDigest } from '../src/cli/fleet-status-digest.js';
import type { StatusDigestSources } from '../src/core/leader/status-digest-sources.js';
import * as config from '../src/core/config.js';

const sources: StatusDigestSources = {
  installedVersion: () => null,
  publishedVersion: async () => '1.2.3',
  mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
  runsState: async () => { throw new Error('unavailable'); },
  needs: () => ({ status: 'missing', items: [] }),
  inbox: async () => ({ sourceState: 'healthy', entries: [] }),
  // This suite pins the original five digest lines, not the later claims line.
  workClaims: undefined,
  // This suite pins the original five digest lines, not the later node-runs line.
  nodeRuns: undefined,
  // This suite pins the original five digest lines, not the later time-to-merge line.
  mergeLatency: undefined,
};
const now = () => new Date('2026-11-11T12:00:00Z');

afterEach(() => vi.restoreAllMocks());

describe('fleet status-digest', () => {
  it('prints five digest lines followed by the work-board summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStatusDigest(['--runs-dir', '/test'], {
      sources,
      now,
      board: () => ({ items: [], inbox: 'ok', truncated: false }),
    })).toBe(0);
    const lines = String(log.mock.calls[0]![0]).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatch(/^Phantom status,/);
    expect(lines.slice(1, 6)).toHaveLength(5);
    expect(lines[4]).toBe('Needs the owner: none waiting');
    expect(lines[6]).toBe('Work items as of 07:00 ET: 0 BLOCKED, 0 RUNNING, 0 ASSIGNED, 0 RECEIVED, 0 VERIFIED');
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

  it('uses the configured name in digest lines without changing the JSON facts', async () => {
    vi.spyOn(config, 'loadConfigReadOnly').mockReturnValue({ ...config.defaultConfig(), user: { name: '  Avery  ' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStatusDigest(['--json'], { sources, now })).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]![0]));
    expect(result.lines).toContain('Needs Avery: none waiting');
    expect(result.facts.needsMason).toEqual({ ok: true, value: 0 });
    expect(result.facts).not.toHaveProperty('ownerName');
  });
});
