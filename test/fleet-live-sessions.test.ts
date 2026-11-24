import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FleetCompute } from '../src/core/fleet/compute-view.js';
import { getFleetSessions, type FleetSessionV1, type FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { readFleetSessionMap, type FleetSessionMap } from '../src/core/fleet/sessions-view.js';
import { buildLiveSessions, renderLiveSessionsText } from '../src/core/fleet/live-sessions.js';
import { readLiveSessions } from '../src/core/fleet/live-sessions-read.js';
import { createFleetLiveSessionsApi } from '../src/core/verse/fleet-live-sessions-api.js';
import { cmdLiveSessions, cmdReconcileSessions, cmdSessions } from '../src/cli/sessions.js';
import { reconcileSessions } from '../src/core/fleet/session-reconciliation.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const session = (job: string, over: Partial<FleetSessionV1> = {}): FleetSessionV1 => ({
  job, repo: 'phantom', lane: 'claude', tier: 'frontier', status: 'running', model: 'fixture-model', batchId: null, pid: null, live: 'yes',
  exitCode: null, timedOut: false, enqueuedAt: ago(40), claimedAt: ago(31), launchedAt: ago(30), startedAt: ago(30), finishedAt: null,
  elapsedSeconds: 1800, durationSeconds: null, queueWaitSeconds: 540, tokensTotal: null, wallSeconds: null, diffLines: null,
  outcome: null, prUrl: null, lastOutputAt: ago(2), ...over,
});
const inventory = (sessions: FleetSessionV1[], recent: FleetSessionV1[] = []): FleetSessionsV1 => ({
  schema: 'fleet.sessions.v1', generatedAt: ago(0), runsDirPresent: true, sourceState: 'healthy',
  sources: { runDir: 'healthy', ready: 'healthy', claimed: 'healthy', precheck: 'healthy', status: 'healthy', metrics: 'healthy', live: 'healthy' },
  dispatcher: null, sessions, recent, counts: { queued: 0, parked: 0, launching: 0, running: sessions.length, publishing: 0, exited: 0, stale: 0 },
  malformed: 0, truncated: false,
});
const node = (id: string, jobs: string[]): FleetCompute['nodes'][number] => ({ id, local: false, owners: [], heartbeatAt: NOW, state: 'ready',
  slots: 2, ramSlots: null, jobs: jobs.map(job => ({ job, owner: null })), stats: null, pressure: null, memguardPaused: null });
const compute = (nodes: FleetCompute['nodes'] = []): FleetCompute => ({ schema: 'fleet.compute.v1', generatedAt: ago(0), localNodeId: 'node-here',
  truncated: false, nodes, sources: {}, dispatcherAt: null, lanes: {} });
/** The real session-map join, with fixtures in and no job-detail reads. */
const sessionMap = (sessions: FleetSessionV1[], nodes: FleetCompute['nodes'] = [], recent: FleetSessionV1[] = []) =>
  readFleetSessionMap({ compute: compute(nodes), sessions: inventory(sessions, recent), now: NOW, readDetail: async () => { throw new Error('no details'); } });

async function mixedFleet(): Promise<FleetSessionMap> {
  return sessionMap([
    session('RQ-CLAUDE-A'),
    session('RQ-CLAUDE-QUIET', { startedAt: ago(50), lastOutputAt: ago(15) }),
    session('RQ-CODEX-NOMODEL', { lane: 'codex-local', tier: 'work', status: 'launching', model: null, lastOutputAt: null, startedAt: ago(1) }),
    session('RQ-CODEX-FAR', { lane: 'codex-local', repo: 'lexicon', tier: 'work', live: 'no', prUrl: 'https://github.com/ashlrai/lexicon/pull/7' }),
    session('RQ-WAIT', { status: 'queued', live: 'no' }),
    session('RQ-STALE', { status: 'stale', live: 'no' }),
  ], [node('node-far', ['RQ-CODEX-FAR', 'RQ-REMOTE-ONLY'])], [session('RQ-DONE', { status: 'finished', prUrl: 'https://github.com/ashlrai/phantom/pull/1' })]);
}

describe('buildLiveSessions', () => {
  it('shows an empty fleet as empty, with no invented rows', async () => {
    const list = buildLiveSessions(await sessionMap([]), NOW);
    expect(list).toEqual({ schema: 'fleet.live-sessions.v1', generatedAt: ago(0), quietAfterMinutes: 10, filter: { lane: null, repo: null },
      counts: { sessions: 0, quiet: 0, lanes: 0, otherComputers: 0 }, sessions: [], gaps: [], live: false,
      tree: { schema: 'fleet.session-tree.v1', version: 1, generatedAt: ago(0), line: 'No agent sessions running.', roots: [],
        counts: { sessions: 0, running: 0, idle: 0, done: 0, failed: 0, unknown: 0, leaders: 0, workers: 0, subagents: 0, orphans: 0, failedLastHour: 0 } } });
    expect(renderLiveSessionsText(list).split('\n')[0]).toBe('No agent sessions running.');
  });

  it('reads an unreadable fleet as unknown, never as an empty fleet', async () => {
    const list = await readLiveSessions({ now: NOW, readMap: async () => { throw new Error('runs dir unreadable'); } });
    expect(list.sessions).toEqual([]);
    expect(list.gaps).toEqual(['Sessions unknown: the session list could not be read.']);
    const missing = buildLiveSessions({ ...await sessionMap([]), runsDirPresent: false, sourceState: 'missing' }, NOW);
    expect(missing.gaps[0]).toMatch(/^No runs directory on this computer/);
  });

  it('lists running sessions across lanes in lane order, then start, then job', async () => {
    const list = buildLiveSessions(await mixedFleet(), NOW);
    expect(list.sessions.map(row => [row.lane, row.job, row.status])).toEqual([
      ['claude', 'RQ-CLAUDE-QUIET', 'running'], ['claude', 'RQ-CLAUDE-A', 'running'],
      ['codex-local', 'RQ-CODEX-FAR', 'running'], ['codex-local', 'RQ-CODEX-NOMODEL', 'launching'],
      ['unknown', 'RQ-REMOTE-ONLY', 'unknown'],
    ]);
    expect(list.counts).toEqual({ sessions: 5, quiet: 1, lanes: 3, otherComputers: 2 });
    expect(list.sessions[1]).toEqual({ job: 'RQ-CLAUDE-A', lane: 'claude', model: 'fixture-model', repo: 'phantom', tier: 'frontier', status: 'running',
      startedAt: ago(30), ageSeconds: 1800, lastOutputAt: ago(2), lastOutputAgeSeconds: 120, quiet: false, prUrl: null,
      computer: 'node-here', thisComputer: true, unknown: {} });
  });

  it('flags a session quiet after 10 minutes without output, and unknown output as unknown', async () => {
    const rows = buildLiveSessions(await mixedFleet(), NOW).sessions;
    const quiet = rows.find(row => row.job === 'RQ-CLAUDE-QUIET')!;
    expect(quiet).toMatchObject({ quiet: true, lastOutputAgeSeconds: 900, ageSeconds: 3000 });
    const edge = buildLiveSessions(await sessionMap([session('RQ-EDGE', { lastOutputAt: ago(10) })]), NOW).sessions[0]!;
    expect(edge.quiet).toBe(false);
    const fresh = rows.find(row => row.job === 'RQ-CODEX-NOMODEL')!;
    expect(fresh).toMatchObject({ quiet: null, lastOutputAt: null, lastOutputAgeSeconds: null });
    expect(fresh.unknown.lastOutputAt).toBe('the worker has not written a log yet');
    const old = { ...session('RQ-OLD-SERVER') } as Partial<FleetSessionV1>;
    delete old.lastOutputAt;
    const legacy = buildLiveSessions(await sessionMap([old as FleetSessionV1]), NOW).sessions[0]!;
    expect(legacy.unknown.lastOutputAt).toBe('this server does not report output times');
  });

  it('names the other computer a session runs on, with a reason for every field only that computer knows', async () => {
    const rows = buildLiveSessions(await mixedFleet(), NOW).sessions;
    expect(rows.find(row => row.job === 'RQ-CODEX-FAR')).toMatchObject({ computer: 'node-far', thisComputer: false, repo: 'lexicon',
      prUrl: 'https://github.com/ashlrai/lexicon/pull/7', unknown: {} });
    const remote = rows.find(row => row.job === 'RQ-REMOTE-ONLY')!;
    expect(remote).toMatchObject({ lane: 'unknown', model: 'unknown', repo: 'unknown', tier: 'unknown', startedAt: null, ageSeconds: null,
      quiet: null, computer: 'node-far', thisComputer: false });
    const why = 'it runs on another computer; its records are only readable there';
    expect(remote.unknown).toEqual({ lane: why, model: why, repo: why, tier: why, startedAt: why, lastOutputAt: why });
    expect(Object.keys(remote.unknown)).toEqual(['lane', 'model', 'repo', 'tier', 'startedAt', 'lastOutputAt']);
  });

  it('shows a missing model as unknown with a reason, and conflicting computers as unknown', async () => {
    const rows = buildLiveSessions(await mixedFleet(), NOW).sessions;
    const row = rows.find(r => r.job === 'RQ-CODEX-NOMODEL')!;
    expect(row.model).toBe('unknown');
    expect(row.unknown).toEqual({ model: 'no launch record or model file names a model yet', lastOutputAt: 'the worker has not written a log yet' });
    const conflict = buildLiveSessions(await sessionMap([session('RQ-BOTH')], [node('node-far', ['RQ-BOTH'])]), NOW).sessions[0]!;
    expect(conflict).toMatchObject({ computer: 'unknown', thisComputer: null, unknown: { computer: 'more than one computer claims it' } });
    const nowhere = buildLiveSessions(await sessionMap([session('RQ-NOWHERE', { live: 'unknown' })]), NOW).sessions[0]!;
    expect(nowhere.unknown.computer).toBe('no computer claims it and no worker process was seen on this computer');
  });

  it('filters by lane and repo, and prints byte-identical JSON for the same inputs', async () => {
    const map = await mixedFleet();
    expect(buildLiveSessions(map, NOW, { lane: 'codex-local' }).sessions.map(row => row.job)).toEqual(['RQ-CODEX-FAR', 'RQ-CODEX-NOMODEL']);
    expect(buildLiveSessions(map, NOW, { repo: 'lexicon' }).sessions.map(row => row.job)).toEqual(['RQ-CODEX-FAR']);
    expect(buildLiveSessions(map, NOW, { lane: 'claude', repo: 'lexicon' })).toMatchObject({ filter: { lane: 'claude', repo: 'lexicon' }, sessions: [] });
    const shuffled = { ...map, mapSessions: [...map.mapSessions].reverse(), sessions: [...map.sessions].reverse() };
    expect(JSON.stringify(buildLiveSessions(shuffled, NOW))).toBe(JSON.stringify(buildLiveSessions(map, NOW)));
    expect(JSON.stringify(await readLiveSessions({ now: NOW, readMap: async () => map }))).toBe(JSON.stringify(buildLiveSessions(map, NOW)));
  });

  it('renders the tree with quiet, computer, PR and unknown reasons in plain words', async () => {
    const text = renderLiveSessionsText(buildLiveSessions(await mixedFleet(), NOW));
    expect(text.split('\n')[0]).toBe('4 sessions running: 4 workers; 2 with state unknown; 1 quiet (no output for 10+ min)');
    expect(text).toContain('\nleader | model unknown | repo unknown | state unknown | last spoke unknown\n');
    expect(text).toContain('  RQ-CLAUDE-QUIET | claude | fixture-model | phantom | running | spoke 15m ago QUIET | on node-here (this computer)');
    expect(text).toContain('  RQ-CODEX-FAR | codex-local | fixture-model | lexicon | running | spoke 2m ago | on node-far | https://github.com/ashlrai/lexicon/pull/7');
    expect(text).toContain('    model unknown: no launch record or model file names a model yet');
    expect(text).toContain('  RQ-REMOTE-ONLY | lane unknown | model unknown | repo unknown | state unknown | last spoke unknown | on node-far');
    expect(text).not.toContain('RQ-DONE'); // its finish time is unknown, so it cannot be placed in the last hour
    expect(text).toContain('note: Leader state, model and messages unknown: no source records the leader session yet.');
  });
});

describe('fleet.sessions.v1 lastOutputAt', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it('reports the worker log mtime as the last output, and null before the log exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-sessions-')); roots.push(root);
    const save = async (name: string, text: string, minutes: number) => {
      const path = join(root, name); await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, text); await utimes(path, new Date(NOW - minutes * 60_000), new Date(NOW - minutes * 60_000));
    };
    await save('queue/run/RQ-LOG.line', 'RQ-LOG phantom claude frontier /fixture/prompt\n', 1);
    await save('RQ-LOG.log', 'working\n', 1);
    await save('queue/run/RQ-NOLOG.line', 'RQ-NOLOG phantom claude frontier /fixture/prompt\n', 1);
    const inv = await getFleetSessions({ runsDir: root, now: () => NOW, runPs: async () => '' });
    expect(inv.sessions.find(row => row.job === 'RQ-LOG')?.lastOutputAt).toBe(ago(1));
    expect(inv.sessions.find(row => row.job === 'RQ-NOLOG')?.lastOutputAt).toBeNull();
  });
});

describe('phm sessions', () => {
  const capture = async (run: () => Promise<number>) => {
    const out: string[] = [];
    let err = '';
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
    try { return { status: await run(), out: out.join('\n'), err }; }
    finally { log.mockRestore(); stderr.mockRestore(); stdout.mockRestore(); }
  };

  it('exposes reconciliation as versioned JSON and plain text, excluding waiting jobs and refusing mutations', async () => {
    const snapshot = inventory([session('WAIT', { status: 'queued' }), session('HELD', { status: 'parked' }),
      session('QUIET', { status: 'stale', live: 'no' }), session('FRESH', { live: 'no' })]);
    const read = vi.fn(async () => snapshot);
    const json = await capture(() => cmdReconcileSessions(['--json'], read));
    expect(json.status).toBe(0);
    expect(JSON.parse(json.out)).toEqual(reconcileSessions(snapshot));
    expect(JSON.parse(json.out).counts).toEqual({ live: 0, finished: 0, unknown: 2 });
    expect((await capture(() => cmdReconcileSessions([], read))).out).toContain('QUIET | unknown');
    expect((await capture(() => cmdSessions(['reconcile', '--apply']))).status).toBe(2);
    expect((await capture(() => cmdSessions(['reconcile', 'JOB']))).status).toBe(2);
    expect((await capture(() => cmdSessions(['reconcile', '--help']))).out).toContain('phm sessions reconcile');
  });

  it('prints the list as JSON or text through the injected reader, passing the filters', async () => {
    const map = await mixedFleet();
    const read = vi.fn((filter: { lane?: string | null; repo?: string | null }) => readLiveSessions({ ...filter, now: NOW, readMap: async () => map }));
    const json = await capture(() => cmdLiveSessions(['--json', '--lane', 'claude'], read));
    expect(json.status).toBe(0);
    expect(read).toHaveBeenLastCalledWith({ lane: 'claude', repo: null });
    expect(JSON.parse(json.out)).toEqual(buildLiveSessions(map, NOW, { lane: 'claude' }));
    const text = await capture(() => cmdLiveSessions(['--repo', 'lexicon'], read));
    expect(text.out).toContain('1 session running: 1 worker; 1 with state unknown (repo lexicon)');
  });

  it('refuses bad flags with usage and exit 2, and keeps the existing verbs and help', async () => {
    const read = vi.fn();
    expect((await capture(() => cmdLiveSessions(['--lane'], read))).status).toBe(2);
    expect((await capture(() => cmdLiveSessions(['--lane', '../x'], read))).status).toBe(2);
    expect((await capture(() => cmdLiveSessions(['--bogus'], read))).status).toBe(2);
    expect(read).not.toHaveBeenCalled();
    const help = await capture(() => cmdSessions(['--help']));
    expect(help.status).toBe(0);
    expect(help.out).toContain('phm sessions [--lane <lane>] [--repo <repo>] [--json]');
    expect((await capture(() => cmdSessions(['help']))).status).toBe(0);
    expect((await capture(() => cmdSessions(['nope']))).status).toBe(2);
  });
});

describe('GET /api/verse/fleet/control/live-sessions', () => {
  const call = async (url: string, opts: { method?: string; session?: boolean; read?: ReturnType<typeof vi.fn> } = {}) => {
    const read = opts.read ?? vi.fn(async (filter: { lane: string | null; repo: string | null }) => buildLiveSessions(await mixedFleet(), NOW, filter));
    let status = 0, body = '';
    const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: (chunk?: string) => { body = chunk ?? ''; } } as unknown as ServerResponse;
    const ctx = { readSession: opts.session === false ? undefined : { expiresAt: Date.now() + 60_000 } } as never;
    const handled = await createFleetLiveSessionsApi(read as never)(ctx, { url } as IncomingMessage, res, url.split('?')[0]!, opts.method ?? 'GET');
    return { handled, status, body: body ? JSON.parse(body) : null, read };
  };

  it('serves the filtered list with a read session and validates the query', async () => {
    const ok = await call('/api/verse/fleet/control/live-sessions?lane=codex-local');
    expect(ok).toMatchObject({ handled: true, status: 200 });
    expect(ok.read).toHaveBeenCalledWith({ lane: 'codex-local', repo: null });
    expect(ok.body.sessions.map((row: { job: string }) => row.job)).toEqual(['RQ-CODEX-FAR', 'RQ-CODEX-NOMODEL']);
    expect((await call('/api/verse/fleet/control/live-sessions', { session: false })).status).toBe(401);
    expect((await call('/api/verse/fleet/control/live-sessions', { method: 'POST' })).status).toBe(405);
    expect((await call('/api/verse/fleet/control/live-sessions?lane=a&lane=b')).status).toBe(400);
    expect((await call('/api/verse/fleet/control/live-sessions?cursor=1')).status).toBe(400);
    expect((await call('/api/verse/fleet/control/live-sessions?repo=..%2Fetc')).status).toBe(400);
    expect((await call('/api/verse/fleet/control/live-sessions', { read: vi.fn(async () => { throw new Error('x'); }) })).status).toBe(503);
    expect((await call('/api/verse/fleet/control/live-map')).handled).toBe(false);
  });
});
