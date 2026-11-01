import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { type MergeWindowRunner } from '../src/core/fleet/phantom-merge-window.js';

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
  return JSON.parse(body) as { generatedAt: string; sources: { merges: string }; mergesLastHour: { count: number | null; perHour: number | null; complete: boolean; medianOpenToMergeMs: number | null; items: Array<{ number: number; repo: string; openedAt: string; mergedAt: string; openToMergeMs: number }> }; publishesLastHour: unknown[] };
}

function apiFor(runner: MergeWindowRunner, now: () => number = () => NOW) {
  return createFleetRunsApi({ now, mergeWindowRunner: runner, readHostLoad: () => null,
    readRunsDir: async () => ({ lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
      publishesLastHour: [{ job: 'created-only', lane: null, url: null, at: new Date(NOW).toISOString() }], events: [] }),
    listWorkers: async () => ({ workers: [], leaders: [], orchestratorAgents: null }),
    readInbox: async () => [], codexPersonal: async () => null });
}

describe('Phantom merge-window recut handler', () => {
  it('projects five validated GitHub merges with the existing speed facts', async () => {
    const runner = vi.fn(async () => ({ stdout: response(Array.from({ length: 5 }, (_, i) => row(i + 1))) }));
    const body = await get(apiFor(runner));
    expect(body.sources.merges).toBe('healthy');
    expect(body.mergesLastHour).toMatchObject({ count: 5, perHour: 5, complete: true, medianOpenToMergeMs: 1_800_000 });
    expect(body.mergesLastHour.items).toHaveLength(5);
    for (const item of body.mergesLastHour.items) {
      expect(item).toMatchObject({ openedAt: '2026-10-31T23:15:00Z', mergedAt: '2026-10-31T23:45:00Z', openToMergeMs: 1_800_000 });
    }
  });

  it('marks incomplete results without substituting the search total', async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ total_count: 47, incomplete_results: true, items: [row(1)] }) }));
    const body = await get(apiFor(runner));
    expect(body.sources.merges).toBe('degraded');
    expect(body.mergesLastHour).toMatchObject({ count: 1, perHour: 1, complete: false });
    expect(body.mergesLastHour.items).toHaveLength(1);
  });

  it('degrades transport failures and retains the local projection', async () => {
    const body = await get(apiFor(async () => { throw new Error('offline'); }));
    expect(body.sources.merges).toBe('degraded');
    expect(body.mergesLastHour).toEqual({ count: null, items: [] });
    expect(body.publishesLastHour).toEqual([{ job: 'created-only', lane: null, url: null, at: new Date(NOW).toISOString() }]);
  });
});
