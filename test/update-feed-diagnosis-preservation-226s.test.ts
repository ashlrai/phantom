import { describe, expect, it, vi, afterEach } from 'vitest';
import { updateFeedDiagnosis } from '../src/core/update-feed-diagnosis.js';
import { cmdFleetUpdateWhy } from '../src/cli/fleet-update-why.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

afterEach(() => vi.restoreAllMocks());

describe('update feed diagnosis preservation (RQ-UPDATEWHYN9SQ8)', () => {
  it('distinguishes an empty release from a missing feed', async () => {
    for (const [assets, reason] of [[[], 'no-assets'], [[{}], 'feed-404']] as const) {
      const fetcher = (async (url: string | URL | Request) => String(url).includes('api.github.com') ? json({ assets }) : json({}, 404)) as typeof fetch;
      expect((await updateFeedDiagnosis('1.0.0', fetcher)).reason).toBe(reason);
    }
  });
  it('reports feed version and current or available status without fetching artifacts', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => { calls.push(String(url)); return json({ version: '2.0.0' }); }) as typeof fetch;
    expect(await updateFeedDiagnosis('2.0.0', fetcher)).toMatchObject({ feedVersion: '2.0.0', reason: 'already-current' });
    expect(await updateFeedDiagnosis('1.0.0', fetcher)).toMatchObject({ feedVersion: '2.0.0', reason: 'available' });
    expect(calls.every(url => url.endsWith('/latest.json'))).toBe(true);
  });
  it('reports offline as unknown', async () => {
    const fetcher = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await updateFeedDiagnosis('1.0.0', fetcher)).toMatchObject({ feedVersion: null, reason: 'unknown' });
  });
  it('reports malformed JSON, a malformed version, and a non-ok feed as unknown', async () => {
    const malformedJson = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    expect(await updateFeedDiagnosis('1.0.0', malformedJson)).toMatchObject({ reason: 'unknown', feedVersion: null });
    for (const body of [{ version: '2.0' }, { version: 'v2.0.0' }, { version: 200 }, {}, { version: ' 2.0.0' }]) {
      const fetcher = (async () => json(body)) as typeof fetch;
      expect(await updateFeedDiagnosis('1.0.0', fetcher)).toMatchObject({ reason: 'unknown', feedVersion: null });
    }
    const failing = (async () => json({}, 500)) as typeof fetch;
    expect(await updateFeedDiagnosis('1.0.0', failing)).toMatchObject({ reason: 'unknown' });
  });
  it('reports unknown when the installed version is missing or unparseable', async () => {
    const fetcher = (async () => json({ version: '2.0.0' })) as typeof fetch;
    expect(await updateFeedDiagnosis(null, fetcher)).toMatchObject({ installedVersion: null, feedVersion: '2.0.0', reason: 'unknown' });
    expect(await updateFeedDiagnosis('not-a-version', fetcher)).toMatchObject({ feedVersion: '2.0.0', reason: 'already-current' });
  });
  it('keeps feed-404 when release metadata fails after the feed 404', async () => {
    for (const release of [
      (async () => { throw new Error('metadata offline'); }),
      (async () => json({}, 500)),
      (async () => json({ assets: [{}] })),
      (async () => json({})),
    ] as const) {
      const fetcher = (async (url: string | URL | Request) => String(url).includes('api.github.com') ? release() : json({}, 404)) as typeof fetch;
      expect(await updateFeedDiagnosis('1.0.0', fetcher)).toMatchObject({ reason: 'feed-404', feedVersion: null });
    }
  });
  it('never claims installation, verification, or a qualified update', async () => {
    const fetcher = (async () => json({ version: '2.0.0' })) as typeof fetch;
    const result = await updateFeedDiagnosis('1.0.0', fetcher);
    expect(result.reason).toBe('available');
    expect(result.message).toContain('signature has not been checked');
    expect(result.message).not.toMatch(/install|verified|qualified/i);
  });
});

describe('fleet update-why CLI', () => {
  const diagnosis = { installedVersion: '1.0.0', feedVersion: '2.0.0', reason: 'available' as const, message: 'A newer version is on the update feed; its signature has not been checked.' };
  it('prints the diagnosis message and JSON without touching the network', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const diagnose = vi.fn(async () => diagnosis);
    expect(await cmdFleetUpdateWhy([], { diagnose })).toBe(0);
    expect(stdout.mock.calls[0]![0]).toBe(diagnosis.message + '\n');
    expect(await cmdFleetUpdateWhy(['--json'], { diagnose })).toBe(0);
    expect(JSON.parse(stdout.mock.calls[1]![0] as string)).toEqual(diagnosis);
    expect(diagnose).toHaveBeenCalledTimes(2);
  });
  it('prints help without diagnosing', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const diagnose = vi.fn(async () => diagnosis);
    expect(await cmdFleetUpdateWhy(['--help'], { diagnose })).toBe(0);
    expect(stdout.mock.calls[0]![0]).toContain('update-why');
    expect(diagnose).not.toHaveBeenCalled();
  });
  it('rejects invalid arguments before any I/O', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const diagnose = vi.fn(async () => diagnosis);
    for (const args of [['--bogus'], ['extra'], ['--json', '--json'], ['--json', 'extra']]) {
      expect(await cmdFleetUpdateWhy(args, { diagnose })).toBe(2);
    }
    expect(stderr).toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
  });
});
