import { describe, expect, it, vi } from 'vitest';
import { awaitReleaseMilestone } from '../src/core/fleet/release-milestone-await.js';
import { cmdFleetReleaseAwait } from '../src/cli/fleet-release-await.js';
import type { ReleaseRunner } from '../src/core/fleet/release-live-notice.js';

const repo = 'ashlrai/phantom', tag = 'v1.2.3', wall = Date.parse('2026-11-05T00:00:00Z');
const names = ['ashlr-phantom-1.2.3.tgz', 'ashlr-phantom-1.2.3.tgz.sig', 'Phantom_1.2.3_aarch64.app.tar.gz', 'Phantom_1.2.3_aarch64.app.tar.gz.sig', 'manifest.json', 'manifest.json.sig', 'latest.json'];
const payload = (draft: boolean, complete: boolean): string => JSON.stringify({ tag_name: tag, published_at: '2026-11-04T00:00:00Z', html_url: `https://github.com/${repo}/releases/tag/${tag}`, draft, prerelease: false, assets: (complete ? names : []).map(name => ({ name, state: 'uploaded', size: 1, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}` })) });
const feed = async () => ({ repo, version: '1.2.3', observedAt: new Date(wall).toISOString() });
const options = { repo, tag, stage: 'feed-ready' as const, timeoutMs: 3000, pollMs: 1000 };
const clock = () => { let time = 0; return { now: () => time, wallNow: () => wall, sleep: async (ms: number) => { time += ms; } }; };

describe('release milestone await', () => {
  it('uses the real classifier through draft, incomplete assets, and published feed', async () => {
    const run = vi.fn<ReleaseRunner>().mockResolvedValueOnce({ code: 0, stdout: payload(true, true) }).mockResolvedValueOnce({ code: 0, stdout: payload(false, false) }).mockResolvedValue({ code: 0, stdout: payload(false, true) });
    const result = await awaitReleaseMilestone(options, { ...clock(), run, feed });
    expect(result.outcome).toBe('observed'); expect(result.attempts).toBe(3);
    expect(result.observations.map(x => x.status)).toEqual(['observed', 'observed', 'unknown']);
    expect(run.mock.calls[0]?.[0]).toEqual(['api', `repos/${repo}/releases/tags/${tag}`]);
  });
  it('times out with last unknown reasons even when feed is ahead', async () => {
    const run: ReleaseRunner = async () => ({ code: 0, stdout: payload(false, false) });
    const result = await awaitReleaseMilestone(options, { ...clock(), run, feed });
    expect(result.outcome).toBe('timed-out'); expect(result.attempts).toBe(3);
    expect(result.observations[0]?.reason).toContain('desktop asset evidence incomplete');
    expect(result.observations[1]?.status).toBe('observed');
  });
  it('cancels during sleep without another probe', async () => {
    const controller = new AbortController();
    const run = vi.fn<ReleaseRunner>().mockResolvedValue({ code: 0, stdout: payload(true, true) });
    const result = await awaitReleaseMilestone({ ...options, signal: controller.signal }, { ...clock(), run, feed, sleep: async () => { controller.abort(); } });
    expect(result.outcome).toBe('cancelled'); expect(run).toHaveBeenCalledTimes(1);
  });
  it('observes once at zero timeout', async () => {
    const run = vi.fn<ReleaseRunner>().mockResolvedValue({ code: 0, stdout: payload(false, true) });
    const result = await awaitReleaseMilestone({ ...options, timeoutMs: 0 }, { ...clock(), run, feed });
    expect(result.outcome).toBe('observed'); expect(result.attempts).toBe(1);
  });
  it('validates before reads and matches JSON outcome to exit status', async () => {
    const run = vi.fn<ReleaseRunner>().mockResolvedValue({ code: 0, stdout: payload(false, true) });
    const emit = vi.fn(); const base = ['--repo', repo, '--tag', tag, '--stage', 'feed-ready'];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const bad of [['--poll-ms', '999'], ['--timeout-ms', '-1'], ['--stage', 'installed'], ['--json', '--json']]) {
      expect(await cmdFleetReleaseAwait([...base, ...bad], { run, feed, emit })).toBe(2);
    }
    expect(run).not.toHaveBeenCalled(); stderr.mockRestore();
    expect(await cmdFleetReleaseAwait([...base, '--timeout-ms', '0', '--json'], { ...clock(), run, feed, emit })).toBe(0);
    expect(JSON.parse(emit.mock.lastCall![0]).outcome).toBe('observed');
    run.mockResolvedValue({ code: 1, stdout: '' });
    expect(await cmdFleetReleaseAwait([...base, '--timeout-ms', '0', '--json'], { ...clock(), run, feed, emit })).toBe(1);
    expect(JSON.parse(emit.mock.lastCall![0]).outcome).toBe('timed-out');
  });
});
