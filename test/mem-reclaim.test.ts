/**
 * `phm mem reclaim` -- plan/apply safety contract over a fake process table
 * and a fake router queue status file.
 *
 * Covers the acceptance bars end to end through planReclaim/applyReclaim:
 * never kill a live job's tree, never kill a codex process attached to a
 * live job (or any codex that is not a finished job's recorded leftover),
 * model unloads go to loopback endpoints only, and dry-run performs no
 * side effects at all.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RECLAIM_OPTIONS,
  ancestorPids,
  computeProtectedPids,
  isCodexProcess,
  loopbackHttpBase,
  parseProcessTable,
  parseQueueStatusJson,
  planReclaim,
  applyReclaim,
  type ProcessRow,
  type QueueStatusView,
  type ReclaimDeps,
  type ReclaimEntry,
  type ReclaimPlanOptions,
} from '../src/core/memory/reclaim.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function row(pid: number, ppid: number, argv: string, rssKb = 100_000, state = 'S', etimesSec = 3600): ProcessRow {
  const name = argv.split(/\s+/)[0]?.split('/').pop()?.toLowerCase() ?? '';
  return { pid, ppid, rssKb, vszKb: rssKb * 2, etimesSec, state, name, argv };
}

const SELF = 9000;

/**
 * Process tree:
 *   1 (launchd)
 *   ├─ 100 login shell
 *   │   ├─ 500 job-pid (live job RQ-A)
 *   │   │   ├─ 501 node        (live job's node worker)
 *   │   │   ├─ 502 esbuild     (live job's esbuild)
 *   │   │   └─ 503 codex       (codex attached to live job)
 *   │   ├─ 600 node dev-server (operator's own, no job)
 *   │   └─ 601 tsserver        (operator's editor, no job)
 *   ├─ 700 node                (recorded pid of finished job RQ-B)
 *   │   └─ 701 cargo           (its leftover child)
 *   ├─ 800 node                (codex-shaped node process, no job at all)
 *   ├─ 810 node                (pid recorded by finished job RQ-C, reused:
 *   │                            started after the job finished)
 *   └─ 9000 self (phm mem reclaim)
 *       └─ 9001 node           (our own child)
 */
function fixtureTable(): ProcessRow[] {
  return [
    row(100, 1, '/bin/zsh -l', 5_000),
    row(500, 100, '/usr/local/bin/node /opt/runner/job.js', 200_000),
    row(501, 500, '/usr/local/bin/node /opt/runner/worker.js', 300_000),
    row(502, 500, '/repo/node_modules/esbuild/bin/esbuild --service=0.25.0', 50_000),
    row(503, 500, '/usr/local/bin/codex exec --job RQ-A', 400_000),
    row(600, 100, '/usr/local/bin/node /app/dev-server.js', 250_000),
    row(601, 100, '/usr/local/bin/node /opt/vscode/tsserver.js --useInferredProjectPerProjectRoot', 700_000),
    row(700, 100, '/usr/local/bin/node /tmp/leftover.js', 180_000, 'S', 7200),
    row(701, 700, '/Users/m/.cargo/bin/cargo build', 60_000, 'S', 7200),
    row(800, 100, '/usr/local/bin/node /usr/local/bin/codex-exec run', 90_000),
    row(810, 100, '/usr/local/bin/node /app/relief.js', 10_000, 'S', 60),
    row(SELF, 100, '/usr/local/bin/node /dist/cli/index.js mem reclaim', 120_000),
    row(SELF + 1, SELF, '/usr/local/bin/node /tmp/child.js', 40_000),
    row(950, 100, '/usr/sbin/rust-analyzer', 400_000, 'Z'),
  ];
}

const FINISHED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const QUEUE_DOC = {
  schema: 'queue.v1',
  jobs: [
    { id: 'RQ-A', status: 'CLAIMED', pid: 500, claims: [{ owner: 'w1', claimedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), pid: 500 }] },
    { id: 'RQ-B', status: 'DONE', pid: 700, claims: [{ owner: 'w2', claimedAt: '2026-10-26T08:00:00Z', finishedAt: FINISHED_AT, pid: 700 }] },
    { id: 'RQ-C', status: 'DONE', pid: 810, claims: [{ owner: 'w3', claimedAt: '2026-10-26T07:00:00Z', finishedAt: FINISHED_AT }] },
    { id: 'RQ-D', status: 'READY' },
  ],
};

function fakeStatus(json: unknown = QUEUE_DOC): QueueStatusView {
  return parseQueueStatusJson(json, '/fake/status.json');
}

interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: { url: string; method: string }[];
  respond: Map<string, { status: number; body: unknown }>;
}

function makeFetch(routes: Record<string, { status?: number; body: unknown }>): FakeFetch {
  const calls: { url: string; method: string }[] = [];
  const respond = new Map<string, { status: number; body: unknown }>();
  for (const [k, v] of Object.entries(routes)) respond.set(k, { status: v.status ?? 200, body: v.body });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET' });
    const hit = respond.get(url);
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, respond };
}

function makeDeps(opts: {
  table?: ProcessRow[];
  status?: QueueStatusView;
  fetch?: FakeFetch;
  alive?: Set<number>;
  swapKb?: (pid: number) => Promise<number | null>;
}): { deps: ReclaimDeps; killed: { pid: number; signal: string }[] } {
  const killed: { pid: number; signal: string }[] = [];
  const alive = opts.alive ?? new Set((opts.table ?? fixtureTable()).map((r) => r.pid));
  return {
    killed,
    deps: {
      readProcessTable: async () => opts.table ?? fixtureTable(),
      readQueueStatus: async () => opts.status ?? fakeStatus(),
      fetchImpl: opts.fetch?.fetchImpl ?? makeFetch({}).fetchImpl,
      killPid: (pid, signal) => {
        killed.push({ pid, signal });
        if (signal === 'SIGKILL') alive.delete(pid);
        if (signal === 'SIGTERM') alive.delete(pid); // cooperative processes
      },
      pidAlive: (pid) => alive.has(pid),
      sleep: async () => {},
      selfPid: SELF,
      ...(opts.swapKb ? { swapKb: opts.swapKb } : {}),
    },
  };
}

function options(overrides: Partial<ReclaimPlanOptions> = {}): ReclaimPlanOptions {
  return { ...DEFAULT_RECLAIM_OPTIONS, ollamaBaseUrl: null, omlxBaseUrl: null, ...overrides };
}

const kills = (entries: ReclaimEntry[]) => entries.filter((e) => e.action === 'kill');
const skips = (entries: ReclaimEntry[]) => entries.filter((e) => e.action === 'skip');
const unloads = (entries: ReclaimEntry[]) => entries.filter((e) => e.action === 'unload');
const killPids = (entries: ReclaimEntry[]) => new Set(kills(entries).map((e) => e.pid));

// ---------------------------------------------------------------------------
// ps parsing
// ---------------------------------------------------------------------------

describe('parseProcessTable', () => {
  it('parses pid/ppid/rss/vsz/etimes/state/args columns', () => {
    const parsed = parseProcessTable(
      '  501   500  300000  600000   120 S    /usr/local/bin/node /opt/runner/worker.js --flag x\n' +
      '    1     0   50000  100000 99999 Ss   /sbin/launchd\n' +
      'garbage line\n',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ pid: 501, ppid: 500, rssKb: 300000, etimesSec: 120, state: 'S', name: 'node' });
    expect(parsed[0]!.argv).toContain('worker.js');
  });
});

describe('queue status parsing', () => {
  it('reads queue.v1 jobs: live vs finished, job and claim pids', () => {
    const view = fakeStatus();
    expect(view.state).toBe('ok');
    expect(view.liveJobPids.has(500)).toBe(true);
    expect(view.finishedJobPids.get(700)?.jobId).toBe('RQ-B');
    const live = view.jobs.find((j) => j.id === 'RQ-A');
    const done = view.jobs.find((j) => j.id === 'RQ-B');
    const ready = view.jobs.find((j) => j.id === 'RQ-D');
    expect(live?.liveness).toBe('live');
    expect(done?.liveness).toBe('finished');
    expect(done?.finishedAtMs).toBe(Date.parse(FINISHED_AT));
    expect(ready?.liveness).toBe('other');
  });

  it('treats PR-OPEN as live and BLOCKED as finished', () => {
    const view = fakeStatus({ jobs: [
      { id: 'a', status: 'PR-OPEN', pid: 11 },
      { id: 'b', status: 'BLOCKED', pid: 22 },
    ] });
    expect(view.liveJobPids.has(11)).toBe(true);
    expect(view.finishedJobPids.get(22)?.jobId).toBe('b');
  });

  it('treats an open claim as live even under a stale status', () => {
    const view = fakeStatus({ jobs: [
      { id: 'a', status: 'READY', claims: [{ owner: 'w', claimedAt: '2026-10-26T01:00:00Z', pid: 42 }] },
    ] });
    expect(view.liveJobPids.has(42)).toBe(true);
    expect(view.jobs[0]?.liveness).toBe('live');
  });

  it('handles grouped and keyed-map shapes', () => {
    const grouped = fakeStatus({ running: [{ id: 'x', state: 'running', pid: 77 }], finished: { 'job-z': { status: 'done', pid: 88 } } });
    expect(grouped.liveJobPids.has(77)).toBe(true);
    expect(grouped.finishedJobPids.get(88)?.jobId).toBe('job-z');
  });

  it('returns invalid for a non-document payload', () => {
    expect(parseQueueStatusJson('hello', null).state).toBe('invalid');
    expect(parseQueueStatusJson(42, null).state).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------

describe('computeProtectedPids', () => {
  it('covers live job pid, its descendants, its ancestors and self chain', () => {
    const table = fixtureTable();
    const prot = computeProtectedPids(table, new Set([500]), SELF);
    for (const pid of [500, 501, 502, 503, 100, SELF, SELF + 1]) {
      expect(prot.has(pid), `pid ${pid}`).toBe(true);
    }
    for (const pid of [600, 601, 700, 701, 800]) {
      expect(prot.has(pid), `pid ${pid}`).toBe(false);
    }
  });

  it('ancestorPids walks the ppid chain', () => {
    const table = fixtureTable();
    expect(ancestorPids(501, table)).toEqual([500, 100]);
    expect(ancestorPids(600, table)).toEqual([100]);
  });
});

describe('codex and orphan matching', () => {
  it('detects codex by argv0 or token basename, not lookalikes', () => {
    expect(isCodexProcess(row(1, 0, '/usr/local/bin/codex exec'))).toBe(true);
    expect(isCodexProcess(row(1, 0, '/usr/bin/node /opt/codex-cli/dist/cli.js'))).toBe(true);
    expect(isCodexProcess(row(1, 0, '/usr/bin/node /opt/codecov/upload.js'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Classification: never kill a live job
// ---------------------------------------------------------------------------

describe('planReclaim', () => {
  it('never kills any pid in a live job tree (acceptance)', async () => {
    const { deps } = makeDeps({});
    const report = await planReclaim(options(), deps);
    const killSet = killPids(report.entries);
    // Every member of the live job RQ-A tree, its ancestors and its codex
    // worker must be absent from the kill list.
    for (const pid of [500, 501, 502, 503, 100]) {
      expect(killSet.has(pid), `pid ${pid} must never be killed`).toBe(false);
    }
    expect(report.queueStatus.liveJobs).toBe(1);
    expect(report.protectedPids).toBeGreaterThanOrEqual(7);
  });

  it('never kills a codex process attached to a live job, and spares stray codex entirely (acceptance)', async () => {
    const { deps } = makeDeps({});
    const report = await planReclaim(options(), deps);
    // No codex-shaped entry is ever a kill candidate.
    const codexish = report.entries.filter((e) => e.reason.toLowerCase().includes('codex'));
    expect(kills(codexish)).toHaveLength(0);
    // The stray codex-shaped node process (pid 800) is reported but skipped.
    const stray = report.entries.find((e) => e.pid === 800);
    expect(stray?.action).toBe('skip');
    expect(stray?.reason).toContain('codex');
    expect(report.entries.some((e) => e.pid === 503)).toBe(false); // deep inside live tree: invisible
  });

  it('kills orphaned node/tsserver and finished-job leftovers (classes b and c)', async () => {
    const { deps } = makeDeps({});
    const report = await planReclaim(options(), deps);
    const killSet = killPids(report.entries);
    expect(killSet.has(600)).toBe(true);  // orphan node dev server
    expect(killSet.has(601)).toBe(true);  // orphan tsserver
    expect(killSet.has(700)).toBe(true);  // RQ-B recorded leftover
    expect(killSet.has(701)).toBe(true);  // its cargo child
    const leftover = report.entries.find((e) => e.pid === 700);
    expect(leftover?.class).toBe('job-leftover');
    expect(leftover?.jobId).toBe('RQ-B');
    expect(report.entries.find((e) => e.pid === 600)?.class).toBe('orphaned-process');
  });

  it('skips a recorded pid that was reused after the job finished', async () => {
    const { deps } = makeDeps({});
    const report = await planReclaim(options(), deps);
    const reused = report.entries.find((e) => e.pid === 810);
    expect(reused?.action).toBe('skip');
    expect(reused?.reason).toContain('pid reuse');
  });

  it('never kills the reclaim process chain itself', async () => {
    const { deps } = makeDeps({});
    const report = await planReclaim(options(), deps);
    const killSet = killPids(report.entries);
    expect(killSet.has(SELF)).toBe(false);
    expect(killSet.has(SELF + 1)).toBe(false);
  });

  it('reports idle resident models from loopback runtime probes (class a)', async () => {
    const fetch = makeFetch({
      'http://127.0.0.1:11434/api/ps': { body: { models: [
        { name: 'qwen3.8:27b', size: 18 * 1024 ** 3, size_vram: 18 * 1024 ** 3, expires_at: '2026-10-26T15:00:00Z' },
      ] } },
      'http://127.0.0.1:8000/admin/api/models': { body: { models: [
        { id: 'mlx/qwen3-32b', is_loaded: true, estimated_size: 20 * 1024 ** 3 },
        { id: 'mlx/cold-model', is_loaded: false },
      ] } },
    });
    const { deps } = makeDeps({ fetch });
    const report = await planReclaim(
      options({ ollamaBaseUrl: 'http://127.0.0.1:11434', omlxBaseUrl: 'http://127.0.0.1:8000' }), deps,
    );
    const pending = unloads(report.entries);
    expect(pending).toHaveLength(2);
    expect(pending.map((e) => `${e.runtime}:${e.model}`).sort()).toEqual([
      'ollama:qwen3.8:27b', 'omlx:mlx/qwen3-32b',
    ]);
    expect(fetch.calls.every((c) => c.url.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('refuses non-loopback runtime urls before any request (loopback-only unload)', async () => {
    const fetch = makeFetch({});
    const { deps } = makeDeps({ fetch });
    const report = await planReclaim(
      options({ ollamaBaseUrl: 'http://192.168.1.20:11434', omlxBaseUrl: 'https://omlx.example.com' }), deps,
    );
    expect(fetch.calls).toHaveLength(0);
    const refused = skips(report.entries).filter((e) => e.class === 'idle-model');
    expect(refused).toHaveLength(2);
    expect(refused.every((e) => e.reason.includes('non-loopback'))).toBe(true);
  });

  it('skips omlx when its admin api requires auth; never sends credentials', async () => {
    const fetch = makeFetch({ 'http://127.0.0.1:8000/admin/api/models': { status: 401, body: { detail: 'unauthorized' } } });
    const { deps } = makeDeps({ fetch });
    const report = await planReclaim(options({ omlxBaseUrl: 'http://127.0.0.1:8000' }), deps);
    const auth = report.entries.find((e) => e.runtime === 'omlx');
    expect(auth?.action).toBe('skip');
    expect(auth?.reason).toContain('requires auth');
    expect(fetch.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('fails closed when the queue status file is unreadable', async () => {
    const { deps } = makeDeps({ status: { state: 'invalid', path: '/x', jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() } });
    const report = await planReclaim(options(), deps);
    expect(report.blocked).toBe('queue-status-unreadable');
    expect(kills(report.entries)).toHaveLength(0);
    expect(report.entries.every((e) => e.action === 'skip')).toBe(true);
  });

  it('with a missing status file there are no live jobs to protect', async () => {
    const { deps } = makeDeps({ status: { state: 'missing', path: '/x', jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() } });
    const report = await planReclaim(options(), deps);
    expect(report.blocked).toBeUndefined();
    const killSet = killPids(report.entries);
    // Job protection gone, but self chain still protected.
    expect(killSet.has(500)).toBe(true); // 'node' with no live ancestors is class (b)
    expect(killSet.has(SELF)).toBe(false);
    expect(killSet.has(SELF + 1)).toBe(false);
    // And the stray codex is still spared: codex is only killable as a recorded leftover.
    expect(killSet.has(800)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

describe('dry-run performs no side effects (acceptance)', () => {
  it('does not kill, signal, or POST anything', async () => {
    const fetch = makeFetch({
      'http://127.0.0.1:11434/api/ps': { body: { models: [{ name: 'm1', size: 1024 ** 3 }] } },
    });
    const { deps, killed } = makeDeps({ fetch });
    const report = await planReclaim(options({ ollamaBaseUrl: 'http://127.0.0.1:11434' }), deps);
    expect(report.mode).toBe('dry-run');
    expect(killed).toHaveLength(0);
    // The only fetch was the read-only /api/ps inventory probe.
    expect(fetch.calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

describe('applyReclaim', () => {
  it('SIGTERMs kill entries and POSTs unloads to the runtime APIs', async () => {
    const fetch = makeFetch({
      'http://127.0.0.1:11434/api/ps': { body: { models: [{ name: 'm1', size: 1024 ** 3 }] } },
      'http://127.0.0.1:11434/api/generate': { body: { done: true } },
    });
    const { deps, killed } = makeDeps({ fetch });
    const opts = options({ apply: true, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    const report = await applyReclaim(await planReclaim(opts, deps), opts, deps);
    const killedPids = new Set(killed.map((k) => k.pid));
    for (const pid of [600, 601, 700, 701]) expect(killedPids.has(pid)).toBe(true);
    for (const pid of [500, 501, 502, 503, 100, SELF, 800]) expect(killedPids.has(pid)).toBe(false);
    expect(killed.every((k) => k.signal === 'SIGTERM')).toBe(true);
    const unload = fetch.calls.find((c) => c.url.endsWith('/api/generate'));
    expect(unload?.method).toBe('POST');
    expect(report.entries.find((e) => e.model === 'm1')?.result).toBe('ok');
    expect(report.totals.errors).toBe(0);
  });

  it('escalates to SIGKILL when a process survives the grace window', async () => {
    const alive = new Set(fixtureTable().map((r) => r.pid));
    const { deps, killed } = makeDeps({ alive });
    const realKill = deps.killPid;
    deps.killPid = (pid, signal) => {
      // SIGTERM does nothing for pid 600; SIGKILL always lands.
      if (signal === 'SIGKILL' || pid !== 600) realKill(pid, signal);
      else killed.push({ pid, signal });
    };
    const report = await applyReclaim(await planReclaim(options({ apply: true }), deps), options({ apply: true, killGraceMs: 0 }), deps);
    expect(killed.some((k) => k.pid === 600 && k.signal === 'SIGKILL')).toBe(true);
    expect(report.entries.find((e) => e.pid === 600)?.result).toBe('ok');
  });

  it('still refuses to act when the plan was blocked', async () => {
    const { deps, killed } = makeDeps({
      status: { state: 'invalid', path: '/x', jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() },
    });
    const opts = options({ apply: true });
    const report = await applyReclaim(await planReclaim(opts, deps), opts, deps);
    expect(killed).toHaveLength(0);
    expect(report.entries.every((e) => e.result === 'skipped')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// URL gate
// ---------------------------------------------------------------------------

describe('loopbackHttpBase', () => {
  it('accepts numeric loopback and localhost, refuses everything else', () => {
    expect(loopbackHttpBase('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(loopbackHttpBase('http://[::1]:8000')).toBe('http://[::1]:8000');
    expect(loopbackHttpBase('http://localhost:8000')).toBe('http://localhost:8000');
    expect(loopbackHttpBase('http://127.999.0.1:11434')).toBeNull();
    expect(loopbackHttpBase('https://127.0.0.1:11434')).toBeNull();
    expect(loopbackHttpBase('http://0.0.0.0:11434')).toBeNull();
    expect(loopbackHttpBase('http://user:pw@127.0.0.1:11434')).toBeNull();
    expect(loopbackHttpBase('http://127.0.0.1:11434/?x=1')).toBeNull();
    expect(loopbackHttpBase('http://192.168.1.1:11434')).toBeNull();
    expect(loopbackHttpBase('not a url')).toBeNull();
  });
});
