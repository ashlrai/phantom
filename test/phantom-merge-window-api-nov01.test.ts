import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createPhantomMergeWindow, type MergeWindowRunner } from '../src/core/fleet/phantom-merge-window.js';

const NOW = Date.parse('2026-11-01T00:10:00Z');
const repo = 'https://api.github.com/repos/ashlrai/phantom';
const row = (number: number, mergedAt: string | null = '2026-10-31T23:45:00Z', repositoryUrl = repo) =>
  ({ repository_url: repositoryUrl, number, title: `PR ${number}`, created_at: '2026-10-31T23:15:00Z', pull_request: { merged_at: mergedAt } });
const response = (items: unknown[], total = items.length) => JSON.stringify({ total_count: total, incomplete_results: false, items });

async function get(api: ReturnType<typeof createFleetRunsApi>) {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = VERSE_FLEET_RUNS_PATH;
  req.headers = {};
  let status = 0;
  let body = '';
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  expect(await api({} as VerseApiContext, req, res, VERSE_FLEET_RUNS_PATH, 'GET')).toBe(true);
  expect(status).toBe(200);
  return JSON.parse(body) as { generatedAt: string; sources: { merges: string }; mergesLastHour: { count: number | null; items: Array<{ number: number; repo: string }> }; publishesLastHour: unknown[] };
}

function apiFor(runner: MergeWindowRunner, now: () => number = () => NOW) {
  return createFleetRunsApi({ now, mergeWindowRunner: runner, readHostLoad: () => null,
    readRunsDir: async () => ({ lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
      publishesLastHour: [{ job: 'created-only', lane: null, url: null, at: new Date(NOW).toISOString() }], events: [] }),
    listWorkers: async () => ({ workers: [], leaders: [], orchestratorAgents: null }),
    readInbox: async () => [], codexPersonal: async () => null });
}

describe('Phantom merge window in fleet runs', () => {
  it('runs a bounded Phantom-only search and validates each returned merge', async () => {
    const runner = vi.fn(async () => ({ stdout: response([
      row(1), row(2, '2026-10-31T23:10:00Z'), row(3, '2026-11-01T00:10:01Z'),
      row(4, null), row(5, undefined, 'https://api.github.com/repos/ashlrai/support'), row(6, '2026-11-01T00:10:00Z'),
    ]) }));
    const body = await get(apiFor(runner));
    expect(runner).toHaveBeenCalledWith('gh', ['api', 'search/issues', '-X', 'GET', '-f',
      'q=repo:ashlrai/phantom is:pr is:merged merged:2026-10-31T23:10:00.000Z..2026-11-01T00:10:00.000Z',
      '-f', 'per_page=100', '-f', 'page=1'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    expect(body.sources.merges).toBe('healthy');
    expect(body.mergesLastHour).toMatchObject({ count: 2, perHour: 2, complete: true, items: [{ repo: 'ashlrai/phantom', number: 1 }, { repo: 'ashlrai/phantom', number: 6 }] });
    expect(body.publishesLastHour).toHaveLength(1);
  });

  it('retrieves and validates every page for more than 30 actual merges', async () => {
    const rows = Array.from({ length: 135 }, (_, i) => row(i + 1));
    const runner = vi.fn(async (_file: string, args: string[]) => ({ stdout: args.includes('page=1') ? response(rows.slice(0, 100), 135) : response(rows.slice(100), 135) }));
    const body = await get(apiFor(runner));
    expect(body.mergesLastHour.count).toBe(135);
    expect(body.mergesLastHour.items).toHaveLength(135);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]![1]).toContain('page=2');
  });

  it.each([
    ['runner failure', async () => { throw new Error('unavailable'); }],
    ['invalid JSON', async () => ({ stdout: '{' })],
    ['duplicate row', async () => ({ stdout: response([row(1), row(1)]) })],
    ['invalid timestamp', async () => ({ stdout: response([row(1, '2026-10-32T00:00:00Z')]) })],
    ['malformed row', async () => ({ stdout: response([{ repository_url: repo }]) })],
  ] as Array<[string, MergeWindowRunner]>)('reports %s as unavailable, never zero', async (_label, runner) => {
    const body = await get(apiFor(runner));
    expect(body.sources.merges).toBe('degraded');
    expect(body.mergesLastHour).toEqual({ count: null, items: [] });
    expect(body.publishesLastHour).toHaveLength(1);
  });

  it('bounds a capped search to ten pages and exposes only validated rows', async () => {
    const runner = vi.fn(async (_file: string, args: string[]) => {
      const page = Number(args.find(arg => arg.startsWith('page='))!.slice(5));
      return { stdout: response(Array.from({ length: 100 }, (_, i) => row((page - 1) * 100 + i + 1)), 1200) };
    });
    const sample = await createPhantomMergeWindow({ runner, now: () => NOW })();
    expect(sample).toMatchObject({ count: 1000, complete: false, sourceState: 'degraded' });
    expect(runner).toHaveBeenCalledTimes(10);
  });

  it('preserves the original observation through the 60 second cache boundary', async () => {
    let clock = NOW;
    const runner = vi.fn(async (_file: string, _args: string[]) => ({ stdout: response([row(1)]) }));
    const api = apiFor(runner, () => clock);
    const first = await get(api);
    clock += 59_999;
    const cached = await get(api);
    expect(first.sources.merges).toBe('healthy');
    expect(cached.sources.merges).toBe('degraded');
    expect(cached.generatedAt).not.toBe(first.generatedAt);
    expect(cached.mergesLastHour.count).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
    clock++;
    // The composite cache has its own two-second lifetime.
    clock += 1999;
    expect((await get(api)).sources.merges).toBe('healthy');
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]![1]).toContain('q=repo:ashlrai/phantom is:pr is:merged merged:2026-10-31T23:11:01.999Z..2026-11-01T00:11:01.999Z');
  });

  it('keeps observation metadata at the adapter and expires precisely at 60 seconds', async () => {
    let clock = NOW;
    const runner = vi.fn(async () => ({ stdout: response([row(1)]) }));
    const read = createPhantomMergeWindow({ runner, now: () => clock });
    expect(await read()).toMatchObject({ observedAt: new Date(NOW).toISOString(), complete: true, cached: false, sourceState: 'healthy' });
    clock += 59_999;
    expect(await read()).toMatchObject({ observedAt: new Date(NOW).toISOString(), cached: true, sourceState: 'degraded' });
    clock++;
    expect(await read()).toMatchObject({ observedAt: new Date(clock).toISOString(), cached: false, sourceState: 'healthy' });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an expired sample when refresh fails', async () => {
    let clock = NOW;
    const runner = vi.fn().mockResolvedValueOnce({ stdout: response([row(1)]) }).mockRejectedValue(new Error('offline'));
    const api = apiFor(runner, () => clock);
    expect((await get(api)).mergesLastHour.count).toBe(1);
    clock += 60_000;
    const failed = await get(api);
    expect(failed.sources.merges).toBe('degraded');
    expect(failed.mergesLastHour).toEqual({ count: null, items: [] });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('honors the existing injected reader without invoking gh', async () => {
    const runner = vi.fn(async () => { throw new Error('must not run'); });
    const api = createFleetRunsApi({ mergedLastHour: async () => ({ count: 4, items: [] }), mergeWindowRunner: runner,
      readRunsDir: async () => null, listWorkers: async () => null, readInbox: async () => [], codexPersonal: async () => null, readHostLoad: () => null });
    expect((await get(api)).mergesLastHour.count).toBe(4);
    expect(runner).not.toHaveBeenCalled();
  });
});
