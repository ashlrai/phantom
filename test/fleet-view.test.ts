/**
 * fleet-view.test.ts: RQ-FLEET-VIEW-V1: one live view for humans and agents.
 *
 * Units under test:
 *   1. readRouterQueue (src/core/fleet/router-queue.ts): the tolerant reader
 *      for ~/.ashlr-runs/queue/{jobs.jsonl,status.json}: bounded files only,
 *      schema-v1 rows, the status overlay applied ONLY when its jobsSha256
 *      binds the exact jobs bytes.
 *   2. buildFleetView (src/core/fleet/view.ts): the fleet-view.v1 aggregate:
 *      agents, accounts (manual fleet.json / resource.v1), queue depth,
 *      throughput + merge rate, impact, host memory/swap, pause, lanes,
 *      per-source provenance. Snapshot-tested from test/fixtures/fleet-view.
 *   3. The fleet-view.v1 JSON schema (schema/fleet-view.v1.schema.json)
 *      validates the aggregate.
 *   4. renderFleetViewFrame (src/tui/render.ts): the TUI frame, golden from
 *      the same fixture view.
 *
 * The goldens (view.golden.json, frame.golden.txt) regenerate against edited
 * fixtures by calling buildFleetView(fixtureOptions()) with TZ=UTC and
 * scrub()bing the volatile mtimeMs fields; this file's fixtureOptions is the
 * recipe.
 *   5. cmdFleet view dispatch + flags (src/cli/fleet.ts).
 *   6. The remote path: /api/verse/fleet/view is a classified READ route,
 *      mutations stay denied, and the document carries no credential-shaped
 *      or path content.
 *   7. getCachedFleetView (src/core/web/fleet-status-cache.ts) TTL behaviour.
 *
 * Everything is hermetic: queue/resource dirs are staged under a fresh
 * tmpdir per test; nowMs, host sample and pause are injected, so no real
 * home directory or clock is ever read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { readRouterQueue, routerQueueDir } from '../src/core/fleet/router-queue.js';
import {
  buildFleetView,
  FLEET_VIEW_SCHEMA,
  type FleetView,
  type FleetViewOptions,
} from '../src/core/fleet/view.js';
import { renderFleetViewFrame } from '../src/tui/render.js';
import {
  getCachedFleetView,
  setFleetViewBuilderForTest,
} from '../src/core/web/fleet-status-cache.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';
import { handleFleetViewApi } from '../src/core/verse/fleet-view-api.js';
import { cmdFleet } from '../src/cli/fleet.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'fleet-view');
const NOW = Date.parse('2026-02-13T16:00:00.000Z');

// An injected host sample: 64G total, 16G free (75% used), 8G swap with 6G free.
const HOST = {
  memoryTotalBytes: 64 * 1024 * 1024 * 1024,
  memoryFreeBytes: 16 * 1024 * 1024 * 1024,
  swapTotalBytes: 8 * 1024 * 1024 * 1024,
  swapFreeBytes: 6 * 1024 * 1024 * 1024,
};

const PAUSE: FleetView['pause'] = { state: 'clear', reason: null };

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-view-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setFleetViewBuilderForTest(null);
  vi.restoreAllMocks();
});

/** Stage the fixture queue pair under <root>/queue. */
function stageQueue(): string {
  const dir = join(root, 'queue');
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURES, 'jobs.jsonl'), join(dir, 'jobs.jsonl'));
  cpSync(join(FIXTURES, 'status.json'), join(dir, 'status.json'));
  return dir;
}

function fixtureOptions(extra: Partial<FleetViewOptions> = {}): FleetViewOptions {
  return {
    nowMs: NOW,
    queueDir: stageQueue(),
    fleetPath: join(FIXTURES, 'fleet.json'),
    resourcePath: join(root, 'resource.json'), // absent: the manual path
    host: HOST,
    pause: PAUSE,
    env: {},
    ...extra,
  };
}

/** Volatile provenance fields scrubbed so the golden compare is deterministic. */
function scrub(view: FleetView): unknown {
  const clone = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
  const sources = clone.sources as Record<string, Record<string, unknown>>;
  for (const key of ['jobs', 'status']) {
    sources[key].mtimeMs = null;
  }
  return clone;
}

// ---------------------------------------------------------------------------
// 1. The queue reader
// ---------------------------------------------------------------------------

describe('readRouterQueue', () => {
  it('serves fixture jobs with the hash-bound overlay applied', () => {
    const snap = readRouterQueue(stageQueue());
    expect(snap.state).toBe('ok');
    expect(snap.jobs).toHaveLength(6);
    expect(snap.jobsFile.state).toBe('ok');
    expect(snap.statusFile.state).toBe('ok');
    expect(snap.statusFile.hashMatched).toBe(true);
    expect(snap.statusFile.applied).toBe(2);
    const job = snap.jobs.find((j) => j.id === 'RQ-FLEET-VIEW-V1');
    expect(job?.outcome).toBe('running');
    // The overlay's token count wins over the log row's.
    expect(job?.tokens).toBe(845000);
  });

  it('keeps the jobs rows when the overlay hash does not bind them', () => {
    const dir = stageQueue();
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { jobsSha256: string };
    status.jobsSha256 = createHash('sha256').update('torn').digest('hex');
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    const snap = readRouterQueue(dir);
    expect(snap.state).toBe('partial');
    expect(snap.jobs).toHaveLength(6);
    expect(snap.statusFile.state).toBe('invalid');
    expect(snap.statusFile.hashMatched).toBe(false);
    expect(snap.statusFile.applied).toBe(0);
    // The un-applied overlay leaves the log row's own tokens in place.
    expect(snap.jobs.find((j) => j.id === 'RQ-FLEET-VIEW-V1')?.tokens).toBe(812345);
  });

  it('reports missing files without throwing', () => {
    const snap = readRouterQueue(join(root, 'empty'));
    expect(snap.state).toBe('missing');
    expect(snap.jobs).toHaveLength(0);
    expect(snap.jobsFile.state).toBe('missing');
    expect(snap.statusFile.state).toBe('missing');
  });

  it('drops malformed rows and merge-evidence contradictions', () => {
    const dir = stageQueue();
    writeFileSync(join(dir, 'jobs.jsonl'),
      readFileSync(join(FIXTURES, 'jobs.jsonl'), 'utf8') +
      'not json\n' +
      '{"schemaVersion":1,"id":"BAD-1","lane":"codex-cmp","tier":"x","mergedAt":"2026-02-13T12:00:00.000Z"}\n' +
      '{"schemaVersion":1,"id":"BAD-2","lane":"codex-cmp","tier":"x","outcome":"merged","mergedAt":"2026-02-13T12:00:00.000Z","startedAt":"2026-02-13T13:00:00.000Z"}\n');
    // The jobs bytes changed: the bound overlay no longer applies (served as partial).
    const snap = readRouterQueue(dir);
    expect(snap.jobs).toHaveLength(6);
    expect(snap.jobsFile.rowsDropped).toBe(3);
    expect(snap.state).toBe('partial');
  });

  it('resolves the queue dir under ASHLR_RUNS_DIR or ~/.ashlr-runs', () => {
    expect(routerQueueDir({ ASHLR_RUNS_DIR: '/r' })).toBe(join('/r', 'queue'));
    expect(routerQueueDir({ HOME: '/h' })).toBe(join('/h', '.ashlr-runs', 'queue'));
  });

  it('rejects a jobs file that is not a regular file', () => {
    const dir = join(root, 'queue');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'jobs.jsonl'));
    const snap = readRouterQueue(dir);
    expect(snap.jobsFile.state).toBe('unsafe');
    expect(snap.jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. buildFleetView: the aggregate
// ---------------------------------------------------------------------------

describe('buildFleetView', () => {
  it('aggregates the fixture into fleet-view.v1', () => {
    const view = buildFleetView(fixtureOptions());
    expect(view.schema).toBe(FLEET_VIEW_SCHEMA);
    expect(view.readOnly).toBe(true);
    expect(view.generatedAt).toBe('2026-02-13T16:00:00.000Z');

    // Agents: the two running rows, oldest start first.
    expect(view.agents.map((a) => a.id)).toEqual(['RQ-FLEET-VIEW-V1', 'RQ-GRAPH-1-r3']);
    const first = view.agents[0]!;
    expect(first.lane).toBe('codex-cmp');
    expect(first.account).toBe('codex-cmp');
    expect(first.repo).toBe('ashlrai/phantom');
    expect(first.elapsedSeconds).toBe(6600); // 14:10 → 16:00
    expect(first.tokens).toBe(845000);       // overlay applied
    // Lane aliases: grok lanes onto the weekly account.
    expect(view.agents[1]!.account).toBe('grok-ultra-weekly');
    expect(view.agents[1]!.elapsedSeconds).toBe(3480);

    // Queue: one queued job (the usage source), two running.
    expect(view.queue.state).toBe('ok');
    expect(view.queue.depth).toBe(1);
    expect(view.queue.running).toBe(2);
    expect(view.queue.jobs).toBe(6);

    // Throughput: 3 completed, 2 merged, one failed; merge rate 2/3.
    expect(view.throughput.completedJobs).toBe(3);
    expect(view.throughput.merged).toBe(2);
    expect(view.throughput.mergeRate).toBeCloseTo(2 / 3);
    expect(view.throughput.reverted).toBe(0);
    expect(view.throughput.recentMerged.map((m) => m.pr)).toEqual([
      'ashlrai/phantom#938', 'ashlrai/phantom#939',
    ]);

    // Impact: every merged row carries impact → the total is known.
    expect(view.impact.total).toBe(23);
    expect(view.impact.perLane[0]!.lane).toBe('codex-cmp');

    // Accounts: manual fleet.json readings + windows.
    const codex = view.accounts.find((a) => a.id === 'codex-cmp')!;
    expect(codex.source).toBe('manual');
    expect(codex.usedPct).toBe(60);
    expect(codex.remainingPct).toBe(40);
    expect(codex.resetAt).toBe('2026-02-20T00:00:00.000Z');
    expect(codex.burnPctPerHour).toBe(5);
    expect(codex.runwayHours).toBe(7); // (100-60)/5 minus the 1 h since the reading
    const grok = view.accounts.find((a) => a.id === 'grok-ultra-weekly')!;
    expect(grok.usedPct).toBe(40);
    expect(grok.idealPct).toBeCloseTo(66.7, 0);
    // Accounts with no reading stay honestly unknown: never fabricated.
    const claude = view.accounts.find((a) => a.id === 'claude-max')!;
    expect(claude.usedPct).toBeNull();
    expect(claude.source).toBe('unknown');

    // Host + pause + provenance.
    expect(view.host.state).toBe('measured');
    expect(view.host.memoryUsedPct).toBe(75);
    expect(view.host.swapUsedBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(view.pause.state).toBe('clear');
    expect(view.sources.jobs.state).toBe('ok');
    expect(view.sources.status.hashMatched).toBe(true);
    expect(view.sources.resources.kind).toBe('manual');

    // The agent map: lanes grouped, running ids attached.
    const cmpLane = view.lanes.find((l) => l.lane === 'codex-cmp')!;
    expect(cmpLane.running).toBe(1);
    expect(cmpLane.agents).toEqual(['RQ-FLEET-VIEW-V1']);
    expect(cmpLane.queued).toBe(0);
  });

  it('matches the checked-in golden projection', () => {
    const view = buildFleetView(fixtureOptions());
    const golden = JSON.parse(readFileSync(join(FIXTURES, 'view.golden.json'), 'utf8')) as unknown;
    expect(scrub(view)).toEqual(golden);
  });

  it('prefers resource.v1 over the manual fleet.json when present', () => {
    cpSync(join(FIXTURES, 'resource.v1.json'), join(root, 'resource.json'));
    const view = buildFleetView(fixtureOptions());
    expect(view.sources.resources.kind).toBe('resource.v1');
    const codex = view.accounts.find((a) => a.id === 'codex-cmp')!;
    expect(codex.source).toBe('resource.v1');
    expect(codex.usedPct).toBe(71.4);
    expect(codex.credits).toBe(12);
    expect(codex.burnPctPerHour).toBe(4.2);
    const devin = view.accounts.find((a) => a.id === 'devin')!;
    expect(devin.source).toBe('estimate');
  });

  it('degrades every source independently and never throws', () => {
    const view = buildFleetView({
      nowMs: NOW,
      queueDir: join(root, 'nope'),
      fleetPath: join(root, 'nope.json'),
      resourcePath: join(root, 'nope2.json'),
      host: { memoryTotalBytes: null, memoryFreeBytes: null, swapTotalBytes: null, swapFreeBytes: null },
      pause: { state: 'unknown', reason: null },
      env: {},
    });
    expect(view.queue.state).toBe('missing');
    expect(view.agents).toHaveLength(0);
    expect(view.accounts.every((a) => a.usedPct === null)).toBe(true);
    expect(view.host.state).toBe('unavailable');
    expect(view.host.memoryUsedPct).toBeNull();
    expect(view.pause.state).toBe('unknown');
    expect(view.sources.resources.kind).toBe('none');
  });

  it('never copies credential-shaped or control content into the view', () => {
    // A hostile jobs row: control bytes in a title, an env-shaped token value,
    // a path-shaped lane: none may survive into the document.
    const dir = stageQueue();
    writeFileSync(join(dir, 'jobs.jsonl'),
      '{"schemaVersion":1,"id":"RQ-OK","lane":"codex-cmp","tier":"frontier","outcome":"running","startedAt":"2026-02-13T15:00:00.000Z","title":"x\\u001b[2J wipe","repo":"ashlrai/phantom"}\n' +
      '{"schemaVersion":1,"id":"RQ-2","lane":"../../../etc","tier":"frontier","outcome":"running","tokens":-5}\n');
    const view = buildFleetView({ nowMs: NOW, queueDir: dir, fleetPath: join(root, 'nope'), resourcePath: join(root, 'nope2'), host: HOST, pause: PAUSE, env: {} });
    const text = JSON.stringify(view);
    // The escaped title survives with its control byte stripped to a space.
    const agent = view.agents.find((a) => a.id === 'RQ-OK');
    expect(agent?.title).toBe('x [2J wipe');
    // The path-shaped lane row was dropped entirely.
    expect(view.agents.some((a) => a.lane.includes('..'))).toBe(false);
    // No filesystem path or credential marker reaches the document.
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/etc\/(?!jobs)|Bearer |sk-[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE/);
  });
});

// ---------------------------------------------------------------------------
// 3. The schema validates the aggregate
// ---------------------------------------------------------------------------

describe('fleet-view.v1 schema', () => {
  it('is a parseable draft-07 document covering the aggregate', () => {
    const schema = JSON.parse(readFileSync(join(HERE, '..', 'schema', 'fleet-view.v1.schema.json'), 'utf8')) as Record<string, unknown>;
    expect(schema['$schema']).toContain('draft-07');
    const required = new Set(schema.required as string[]);
    for (const key of ['schema', 'generatedAt', 'readOnly', 'pause', 'host', 'queue', 'agents', 'accounts', 'throughput', 'impact', 'lanes', 'sources']) {
      expect(required.has(key), `schema requires ${key}`).toBe(true);
    }
    // The view's own top-level keys are exactly the required set.
    const view = buildFleetView(fixtureOptions());
    expect(Object.keys(view).sort()).toEqual([...required].sort());
    // Per-object spot checks: every required field is present and typed.
    for (const agent of view.agents) {
      for (const k of ['id', 'lane', 'account', 'tier', 'repo', 'title', 'startedAt', 'elapsedSeconds', 'tokens']) {
        expect(agent, `agent.${k}`).toHaveProperty(k);
      }
    }
    for (const acct of view.accounts) {
      for (const k of ['id', 'lanes', 'sharedWith', 'source', 'usedPct', 'remainingPct', 'credits', 'resetAt', 'windowStart', 'burnPctPerHour', 'runwayHours', 'projectedPct', 'idealPct', 'readingAt', 'ageSeconds']) {
        expect(acct, `account.${k}`).toHaveProperty(k);
      }
      expect(['resource.v1', 'manual', 'estimate', 'unknown']).toContain(acct.source);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The TUI frame
// ---------------------------------------------------------------------------

describe('renderFleetViewFrame', () => {
  it('renders the fixture view deterministically (golden frame)', () => {
    const view = buildFleetView(fixtureOptions());
    const frame = renderFleetViewFrame(view, { nowMs: NOW, cols: 100 });
    const golden = readFileSync(join(FIXTURES, 'frame.golden.txt'), 'utf8');
    expect(frame).toBe(golden);
  });

  it('carries every required section at a narrow width', () => {
    const view = buildFleetView(fixtureOptions());
    const frame = renderFleetViewFrame(view, { nowMs: NOW, cols: 60 });
    expect(frame).toContain('ashlr fleet');
    expect(frame).toContain('Agents');
    expect(frame).toContain('Accounts');
    expect(frame).toContain('Queue');
    expect(frame).toContain('Host');
    expect(frame).toContain('Agent map');
    expect(frame).toContain('LIVE');
    expect(frame).toContain('RQ-FLEET-VIEW-V1');
    expect(frame).toContain('codex-cmp');
  });

  it('renders the degraded view without throwing', () => {
    const view = buildFleetView({
      nowMs: NOW,
      queueDir: join(root, 'nope'),
      fleetPath: join(root, 'nope.json'),
      resourcePath: join(root, 'nope2.json'),
      host: { memoryTotalBytes: null, memoryFreeBytes: null, swapTotalBytes: null, swapFreeBytes: null },
      pause: { state: 'unknown', reason: null },
      env: {},
    });
    const frame = renderFleetViewFrame(view, { nowMs: NOW, cols: 100 });
    expect(frame).toContain('no agents running');
    expect(frame).toContain('PAUSE?');
  });
});

// ---------------------------------------------------------------------------
// 5. CLI dispatch
// ---------------------------------------------------------------------------

describe('phm fleet view', () => {
  function captureStdout(fn: () => Promise<number>): { code: Promise<number>; out: () => string } {
    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      buf += String(chunk);
      return true;
    });
    void spy;
    return { code: fn(), out: () => buf };
  }

  it('--json emits the fleet-view.v1 document', async () => {
    const { code, out } = captureStdout(() => cmdFleet(['view', '--json']));
    expect(await code).toBe(0);
    const doc = JSON.parse(out()) as FleetView;
    expect(doc.schema).toBe('fleet-view.v1');
    expect(doc.readOnly).toBe(true);
  });

  it('--once renders one frame to stdout', async () => {
    const { code, out } = captureStdout(() => cmdFleet(['view', '--once']));
    expect(await code).toBe(0);
    expect(out()).toContain('ashlr fleet');
    expect(out()).toContain('Agents');
  });

  it('rejects an unknown option and a bad interval', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleet(['view', '--bogus'])).toBe(2);
    expect(await cmdFleet(['view', '--interval', 'abc'])).toBe(2);
    expect(await cmdFleet(['view', '--interval', '10'])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. The remote path: read-only, allowlisted, redacted
// ---------------------------------------------------------------------------

describe('remote fleet view', () => {
  it('classifies GET /api/verse/fleet/view as a read route', () => {
    expect(classifyRemoteRoute('GET', '/api/verse/fleet/view')).toEqual({ kind: 'read', path: '/api/verse/fleet/view' });
  });

  it('denies every mutation shape on the route', () => {
    expect(classifyRemoteRoute('POST', '/api/verse/fleet/view')).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('DELETE', '/api/verse/fleet/view')).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('PUT', '/api/verse/fleet/view')).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('GET', '/api/verse/fleet/view?x=1')).toEqual({ kind: 'deny' });
  });

  it('the API answers the document and refuses non-GET methods', async () => {
    const writes: { status: number; body: unknown }[] = [];
    const res = {
      headersSent: false,
      writeHead: (status: number, _h: unknown) => { writes.push({ status, body: null }); res.headersSent = true; return res; },
      setHeader: () => res,
      end: (body?: string) => { if (writes.length > 0) writes[writes.length - 1]!.body = body ? JSON.parse(body) : null; },
      on: () => res, once: () => res, emit: () => res,
    } as unknown as import('node:http').ServerResponse;
    const req = { url: '/api/verse/fleet/view', headers: {} } as unknown as import('node:http').IncomingMessage;
    const ctx = {} as Parameters<typeof handleFleetViewApi>[0];

    expect(await handleFleetViewApi(ctx, req, res, '/api/verse/fleet/view', 'GET')).toBe(true);
    expect(writes.at(-1)?.status).toBe(200);
    const doc = writes.at(-1)?.body as FleetView;
    expect(doc.schema).toBe('fleet-view.v1');
    expect(doc.readOnly).toBe(true);

    expect(await handleFleetViewApi(ctx, req, res, '/api/verse/fleet/view', 'POST')).toBe(true);
    expect(writes.at(-1)?.status).toBe(405);
    expect(await handleFleetViewApi(ctx, req, res, '/api/verse/fleet/other', 'GET')).toBe(false);
  });

  it('the served document carries no credential-shaped or path content', async () => {
    const view = getCachedFleetView();
    const text = JSON.stringify(view);
    // No filesystem paths, env names or credential markers may reach the wire.
    // (Token *counts* are a field; the scan is for credential-shaped values.)
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/etc\/|ASHLR_|HOME=|Bearer |sk-[A-Za-z0-9]|api[_-]?key|secret|password|BEGIN [A-Z ]*PRIVATE/i);
    expect(view.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. The cache
// ---------------------------------------------------------------------------

describe('getCachedFleetView', () => {
  it('serves the TTL window from one build and rebuilds after it', () => {
    let builds = 0;
    setFleetViewBuilderForTest(() => {
      builds += 1;
      return { schema: FLEET_VIEW_SCHEMA, generatedAt: `build-${builds}` } as unknown as FleetView;
    });
    const first = getCachedFleetView();
    expect(getCachedFleetView()).toBe(first);
    expect(builds).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2_500);
    const second = getCachedFleetView();
    expect(second).not.toBe(first);
    expect(second.generatedAt).toBe('build-2');
    expect(builds).toBe(2);
  });
});

