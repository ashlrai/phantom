// Recut of #3250 (RQ-RESOURCES-1-FEED): GET /api/app/fleet-usage serves the
// fleet-usage.v1 feed the Resources > Lane usage panel already parses.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFleetUsageFeed, type FleetUsageFeedV1 } from '../src/core/resources/fleet-usage.js';
import { handleApi } from '../src/core/web/api.js';
import { buildLaneCards, parseFleetUsage } from '../src/web-ui/routes/resources/fleet-usage-model.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const status = {
  schema: 'dispatchd.status.v1', last_tick: '2026-11-09T11:58:00Z', paused: null, mem_free_pct: 40,
  lanes: {
    claude: { running: 1, target: 2, floor: 0, ceiling: 8, held: false, queued: 3 },
    'codex-cmp': { running: 4, target: 10, floor: 10, ceiling: 32, held: true, held_reason: 'autobackoff after auth failure', queued: 5 },
    'claude-api': { running: 0, target: 1, floor: 0, ceiling: 8, held: false, queued: 0 },
    'codex-local': { running: 3, target: 6, floor: 0, ceiling: 6, held: false, queued: 0 },
  },
  budget: {
    // Fresh, timestamped reading: the only lane reported as known and current.
    claude: { weekly_used_pct: 62, reset_at: '2026-11-11T12:00:00Z', burn_pct_per_hour: 0.6, observed_at: '2026-11-09T11:57:00Z' },
    // The counter belongs to a window that already reset.
    'codex-cmp': { weekly_used_pct: 40, reset_at: '2026-11-09T06:00:00Z', burn_pct_per_hour: 1 },
    // Dollars, not a percentage.
    'claude-api': { credits_remaining: 25 },
    // Budget-only lane with a hand-typed reading and no capture time.
    'codex-personal': { weekly_used_pct: 45, reset_at: '2026-11-12T00:00:00Z' },
  },
};

async function runsDir(root: string, body: unknown = status): Promise<string> {
  await mkdir(join(root, 'queue'), { recursive: true });
  await writeFile(join(root, 'queue/status.json'), JSON.stringify(body));
  return root;
}
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recut-usage-3250-'));
  roots.push(root);
  return root;
}
const read = async (root: string) => readFleetUsageFeed({ runsDir: root, now: () => NOW, personalCodexHome: join(root, 'codex-home') });
const byLane = (feed: FleetUsageFeedV1) => Object.fromEntries(feed.lanes.map(lane => [lane.lane, lane]));

describe('fleet-usage.v1 feed (recut of #3250)', () => {
  it('reports a fresh weekly reading with slot counts and its own age', async () => {
    const feed = await read(await runsDir(await tempRoot()));
    expect(feed.schema).toBe('fleet-usage.v1');
    expect(feed.generatedAt).toBe('2026-11-09T12:00:00.000Z');
    expect(feed.lanes.map(lane => lane.lane)).toEqual(['claude', 'claude-api', 'codex-cmp', 'codex-local', 'codex-personal']);
    expect(byLane(feed).claude).toEqual({
      lane: 'claude', window: 'weekly', usedPct: 62, resetAt: '2026-11-11T12:00:00Z', burnPctPerHour: 0.6,
      running: 1, target: 2, ceiling: 8, queued: 3, held: false, heldReason: null, sourceAgeSec: 180, stale: false,
    });
  });

  it('keeps unknown readings unknown instead of showing a figure', async () => {
    const lanes = byLane(await read(await runsDir(await tempRoot())));
    // Reset passed: the old counter is not this window's usage.
    expect(lanes['codex-cmp']).toMatchObject({ usedPct: null, resetAt: null, burnPctPerHour: null, held: true,
      heldReason: 'autobackoff after auth failure', ceiling: 32, queued: 5, sourceAgeSec: 120, stale: false });
    // Credits are dollars; never rendered as a percentage.
    expect(lanes['claude-api']).toMatchObject({ window: 'credits', usedPct: null, burnPctPerHour: null });
    // No reading at all.
    expect(lanes['codex-local']).toMatchObject({ window: 'weekly', usedPct: null, resetAt: null, ceiling: 6 });
    // A hand-typed reading with no capture time is shown, but flagged stale with an unknown age.
    expect(lanes['codex-personal']).toMatchObject({ usedPct: 45, sourceAgeSec: null, stale: true, running: null, ceiling: null });
  });

  it('round-trips through the panel parser, so the wire contract cannot drift', async () => {
    const feed = await read(await runsDir(await tempRoot()));
    const parsed = parseFleetUsage(JSON.parse(JSON.stringify(feed)));
    expect(parsed).toEqual(feed);
    const cards = Object.fromEntries(buildLaneCards(parsed, NOW).map(card => [card.lane.lane, card]));
    expect(cards.claude!.remainingPct).toBe(38);
    expect(cards.claude!.risk.level).not.toBe('unknown');
    for (const lane of ['claude-api', 'codex-cmp', 'codex-local']) expect(cards[lane]!.risk.level).toBe('unknown');
    expect(cards['codex-personal']!.stale).toBe(true);
  });

  it('degrades to an empty feed for a missing or malformed runs dir', async () => {
    const root = await tempRoot();
    expect((await read(join(root, 'absent'))).lanes).toEqual([]);
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/status.json'), '{not json');
    expect((await read(root)).lanes).toEqual([]);
  });
});

describe('GET /api/app/fleet-usage', () => {
  function call(method: string) {
    let body = '';
    const writeHead = vi.fn();
    const res = { writeHead, setHeader: vi.fn(), end: vi.fn((chunk?: string) => { body = chunk ?? ''; }) } as unknown as ServerResponse;
    const req = { url: '/api/app/fleet-usage', method, headers: {} } as IncomingMessage;
    return handleApi(req, res, {} as never, { token: 'test', allowDispatch: false })
      .then(handled => ({ handled, status: writeHead.mock.calls[0]?.[0] as number, body: body ? JSON.parse(body) as unknown : null }));
  }

  it('serves the feed from the runs dir under HOME', async () => {
    // test/setup/home.ts relocates HOME to a per-worker temp dir.
    const root = join(homedir(), '.ashlr-runs');
    await runsDir(root);
    roots.push(root);
    const result = await call('GET');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    const feed = parseFleetUsage(result.body);
    expect(feed.lanes.map(lane => lane.lane)).toEqual(['claude', 'claude-api', 'codex-cmp', 'codex-local', 'codex-personal']);
    expect(feed.lanes.find(lane => lane.lane === 'codex-cmp')?.usedPct).toBeNull();
  });

  it('refuses writes', async () => {
    const result = await call('POST');
    expect(result).toMatchObject({ handled: true, status: 405 });
  });
});
