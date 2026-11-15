import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH as PATH } from '../src/core/verse/fleet-runs-types.js';

const TOKEN = 'fleet-test-token';
const NOW = Date.parse('2026-10-31T12:00:00Z');

/** A tmp fleet root with metrics/jobs.jsonl when text is provided. */
function fleetRoot(jobsJsonl: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'fleet-overrun-'));
  if (jobsJsonl !== null) {
    mkdirSync(join(root, 'metrics'), { recursive: true });
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), jobsJsonl);
  }
  return root;
}

/** launch+finish pairs with a dispatcher wall_s, all inside the read window. */
function ledger(lane: string, finishes: number, wallS: number): string {
  const rows: string[] = [];
  for (let i = 1; i <= finishes; i++) {
    rows.push(JSON.stringify({ event: 'launch', job: `RQ-FAKE-A${i}`, lane, repo: 'phantom', ts: '2026-10-31T07:00:00Z' }));
    rows.push(JSON.stringify({ event: 'finish', job: `RQ-FAKE-A${i}`, lane, ts: '2026-10-31T07:40:00Z', wall_s: wallS }));
  }
  return `${rows.join('\n')}\n`;
}

const workers = {
  workers: [
    { job: 'RQ-FAKE-LIVE1', repo: 'fake/repo', lane: 'devin', tier: 'mid', ageSeconds: 6_000 },
    { job: 'RQ-FAKE-LIVE2', repo: 'fake/repo', lane: 'claude', tier: 'mid', ageSeconds: 6_000 },
    { job: 'RQ-FAKE-LIVE3', repo: 'fake/repo', lane: 'devin', tier: 'mid', ageSeconds: 60 },
  ],
  leaders: [], orchestratorAgents: 0,
};

function deps(over: Partial<FleetRunsApiDeps> = {}): FleetRunsApiDeps {
  return { now: () => NOW,
    readRunsDir: async () => ({ lastTick: new Date(NOW).toISOString(), paused: false, memFreePct: 40, diskFreeGb: 20, switches: [], claudeLane: null, lanes: [], publishesLastHour: [], events: [] }),
    listWorkers: async () => workers,
    readInbox: async () => [], appendInbox: async () => ({ ok: true }),
    codexPersonal: async () => null, mergedLastHour: async () => ({ count: 0, items: [] }), ...over };
}

async function get(api: ReturnType<typeof createFleetRunsApi>): Promise<{ handled: boolean; status: number; wire: Record<string, unknown> | null }> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = PATH; req.method = 'GET'; req.headers = { 'x-ashlr-token': TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text) as Record<string, unknown>; } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext;
  const handled = await api(ctx, req, res, PATH, 'GET');
  return { handled, status, wire };
}

type WireWorker = { job: string; lane: string; ageSeconds: number | null; overrun?: { ratio: number; medianMs: number } };

describe('fleet runs worker overrun flag', () => {
  it('adds overrun to a running job over 2x its lane median, and nowhere else', async () => {
    const { status, wire } = await get(createFleetRunsApi(deps({ runsDir: fleetRoot(ledger('devin', 5, 2_400)) })));
    expect(status).toBe(200);
    const rows = wire!.workers as WireWorker[];
    expect(rows.map(row => row.job)).toEqual(['RQ-FAKE-LIVE1', 'RQ-FAKE-LIVE2', 'RQ-FAKE-LIVE3']);
    // 100 min elapsed vs a 40 min lane median.
    expect(rows[0]!.overrun).toEqual({ ratio: 2.5, medianMs: 2_400_000 });
    // A lane without finished history and a job under the 20 minute floor get no flag.
    expect(rows[1]!.overrun).toBeUndefined();
    expect(rows[2]!.overrun).toBeUndefined();
  });

  it('still returns the read when the jobs file is malformed', async () => {
    const { status, wire } = await get(createFleetRunsApi(deps({ runsDir: fleetRoot('this is not json\n{"event":\n') })));
    expect(status).toBe(200);
    const rows = wire!.workers as WireWorker[];
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.overrun === undefined)).toBe(true);
  });

  it('still returns the read when the jobs file is missing', async () => {
    const { status, wire } = await get(createFleetRunsApi(deps({ runsDir: fleetRoot(null) })));
    expect(status).toBe(200);
    const rows = wire!.workers as WireWorker[];
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.overrun === undefined)).toBe(true);
  });
});
